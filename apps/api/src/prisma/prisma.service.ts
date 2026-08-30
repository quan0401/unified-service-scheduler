/**
 * Prisma client lifecycle, plus the session settings that keep this service
 * responsive under contention.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    await this.applyTimeouts();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Bounds how long any single statement may block.
   *
   * Under a booking stampede the failure mode to avoid is queueing: requests
   * pile up waiting on the same slot, hold connections, and exhaust the pool,
   * turning a contended slot into a service-wide outage. Failing fast converts
   * that into a clean 409 for the few requests that lost, while the rest of the
   * dealership keeps booking.
   *
   * Set at database level so it applies to every connection the pool opens,
   * including ones created after startup.
   */
  private async applyTimeouts(): Promise<void> {
    const lockTimeout = Number(process.env.DB_LOCK_TIMEOUT_MS ?? 2000);
    const statementTimeout = Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 5000);

    try {
      const database = await this.$queryRaw<{ current_database: string }[]>`
        SELECT current_database()
      `;
      const name = database[0]?.current_database;
      if (!name) return;

      await this.$executeRawUnsafe(
        `ALTER DATABASE "${name}" SET lock_timeout = ${lockTimeout}`,
      );
      await this.$executeRawUnsafe(
        `ALTER DATABASE "${name}" SET statement_timeout = ${statementTimeout}`,
      );
    } catch (error) {
      // Requires database ownership. Not fatal -- the service still works, it
      // just queues rather than failing fast -- but it must be visible.
      this.logger.warn(
        `Could not apply lock/statement timeouts: ${(error as Error).message}. ` +
          'Set them on the database or role manually in production.',
      );
    }
  }
}
