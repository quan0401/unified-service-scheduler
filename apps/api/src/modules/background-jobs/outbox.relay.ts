/**
 * Transactional outbox relay.
 *
 * Confirmation notifications must not be sent from inside the booking path.
 * Two reasons, both load-bearing:
 *
 *   1. Correctness -- an email sent inside a transaction that later rolls back
 *      tells the customer about an appointment that does not exist. The intent
 *      is written as a row by the same STATEMENT that creates the appointment
 *      (see BookingRepository), which makes the two atomic: either both exist
 *      or neither does.
 *   2. Contention -- any network call inside the booking transaction extends
 *      the window during which the slot is locked from milliseconds to
 *      hundreds. Keeping transactions short is what keeps the conflict rate low.
 *
 * The relay is at-least-once, not exactly-once. Downstream consumers must be
 * idempotent; `aggregateId` plus `eventType` is the natural deduplication key.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';

/** Bounded so one poll cannot monopolise a connection under a backlog. */
const RELAY_BATCH_SIZE = 100;

@Injectable()
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async publishPending(): Promise<void> {
    const pending = await this.prisma.outboxEvent.findMany({
      where: { publishedAt: null },
      orderBy: { createdAt: 'asc' },
      take: RELAY_BATCH_SIZE,
    });

    if (pending.length === 0) return;

    for (const event of pending) {
      try {
        await this.dispatch(event.eventType, event.payload);
        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: { publishedAt: new Date(), attemptCount: { increment: 1 } },
        });
      } catch (error) {
        // Left unpublished so the next poll retries. Never rethrown: one bad
        // event must not stall the rest of the batch.
        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: { attemptCount: { increment: 1 } },
        });
        this.logger.error(
          `Failed to publish outbox event ${event.id} (${event.eventType}): ` +
            `${(error as Error).message}`,
        );
      }
    }
  }

  /**
   * Stand-in for a real transport.
   *
   * In production this publishes to a broker (SNS, Kafka, RabbitMQ) or calls a
   * notification service. The seam is deliberately narrow so swapping it does
   * not touch the booking path.
   */
  private dispatch(eventType: string, payload: unknown): Promise<void> {
    this.logger.log(`Published ${eventType}: ${JSON.stringify(payload)}`);
    return Promise.resolve();
  }
}
