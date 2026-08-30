/**
 * Reclaims lapsed reservations.
 *
 * This job is housekeeping, not correctness. Availability and booking both
 * treat a hold whose `hold_expires_at` has passed as free, so a slot is
 * released the instant it expires regardless of when this runs. The sweeper
 * exists to stop expired rows accumulating inside the exclusion constraints'
 * partial indexes, which would slowly enlarge them and degrade the overlap
 * probes that every booking depends on.
 *
 * That separation is deliberate: correctness that depends on a background job
 * running on time is correctness that fails when the job is late.
 *
 * This cron runs in every API replica, and deliberately does not coordinate.
 * Unlike the outbox relay -- where uncoordinated replicas each publish the same
 * event -- the delete below is a single idempotent statement: PostgreSQL
 * serialises concurrent deletes on the same rows and the losers simply delete
 * nothing. Concurrent sweeps waste a query, never correctness. A leader lock
 * here would add a failure mode (leader dies, sweeping stops) to buy nothing.
 *
 * The gauge is likewise per-replica by design: each instance keeps its own
 * prom-client registry and is scraped separately, so a local reading is the
 * correct one rather than a conflicting one.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AppointmentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../observability/metrics.service';

@Injectable()
export class HoldSweeper {
  private readonly logger = new Logger(HoldSweeper.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async sweep(): Promise<void> {
    const { count } = await this.prisma.appointment.deleteMany({
      where: { status: AppointmentStatus.HELD, holdExpiresAt: { lt: new Date() } },
    });

    if (count > 0) this.logger.debug(`Reclaimed ${count} expired hold(s).`);

    this.metrics.setActiveHolds(
      await this.prisma.appointment.count({
        where: { status: AppointmentStatus.HELD, holdExpiresAt: { gt: new Date() } },
      }),
    );
  }
}
