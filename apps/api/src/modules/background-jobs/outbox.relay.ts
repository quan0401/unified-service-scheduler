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
 *
 * COORDINATION -- this cron runs in every API replica, so the batch must be
 * partitioned rather than duplicated. `FOR UPDATE SKIP LOCKED` does that: each
 * relay locks a batch, concurrent relays skip those rows and take the next
 * unclaimed ones. Duplicates then come only from a genuine retry, not from the
 * replica count, and throughput rises with replicas instead of being serialised
 * behind a leader. The arbiter is PostgreSQL, exactly as it is for booking.
 *
 * Two consequences worth naming:
 *
 *   - Crash recovery is free. A relay that dies mid-batch rolls its transaction
 *     back and the rows become visible to other replicas immediately -- no lease
 *     to expire, no stuck-row reaper to run.
 *   - `ORDER BY created_at` is rough FIFO, not a global ordering. Concurrent
 *     relays claim disjoint batches and finish independently, so a consumer that
 *     needs per-aggregate ordering must impose it itself.
 *
 * The claim is held for the length of the dispatch loop. That is correct while
 * `dispatch()` stays in-process; a real broker call belongs outside the lock,
 * at which point this becomes claim-commit-publish against a `claimed_until`
 * lease column. The deciding factor is dispatch latency, not batch size.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** Bounded so one poll cannot monopolise a connection under a backlog. */
export const RELAY_BATCH_SIZE = 100;

/**
 * Bounds how long the claim may hold its rows. Above the 10s cron interval so a
 * slow batch is not killed spuriously, but finite: a wedged relay must release
 * its rows rather than hold them until the process dies.
 */
const RELAY_TRANSACTION_TIMEOUT_MS = 15_000;

/** Fail fast rather than queue when the connection pool is saturated. */
const RELAY_MAX_WAIT_MS = 5_000;

/** One claimed row. Aliased to camelCase because $queryRaw bypasses Prisma's field mapping. */
interface ClaimedEvent {
  id: string;
  eventType: string;
  payload: Prisma.JsonValue;
}

@Injectable()
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async publishPending(): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        // Raw SQL because Prisma's query API cannot express SKIP LOCKED, which
        // is the whole point of this statement.
        const claimed = await tx.$queryRaw<ClaimedEvent[]>`
          SELECT id, event_type AS "eventType", payload
          FROM outbox_event
          WHERE published_at IS NULL
          ORDER BY created_at
          LIMIT ${RELAY_BATCH_SIZE}
          FOR UPDATE SKIP LOCKED
        `;

        if (claimed.length === 0) return;

        const published: string[] = [];
        const failed: string[] = [];

        for (const event of claimed) {
          try {
            await this.dispatch(event.eventType, event.payload);
            published.push(event.id);
          } catch (error) {
            // Left unpublished so the next poll retries. Never rethrown: one bad
            // event must not stall the rest of the batch.
            failed.push(event.id);
            this.logger.error(
              `Failed to publish outbox event ${event.id} (${event.eventType}): ` +
                `${(error as Error).message}`,
            );
          }
        }

        // Two statements rather than one per event: the claim is already held,
        // so every extra round trip is lock time paid for nothing.
        if (published.length > 0) {
          await tx.outboxEvent.updateMany({
            where: { id: { in: published } },
            data: { publishedAt: new Date(), attemptCount: { increment: 1 } },
          });
        }

        if (failed.length > 0) {
          await tx.outboxEvent.updateMany({
            where: { id: { in: failed } },
            data: { attemptCount: { increment: 1 } },
          });
        }
      },
      { timeout: RELAY_TRANSACTION_TIMEOUT_MS, maxWait: RELAY_MAX_WAIT_MS },
    );
  }

  /**
   * Stand-in for a real transport.
   *
   * In production this publishes to a broker (SNS, Kafka, RabbitMQ) or calls a
   * notification service. The seam is deliberately narrow so swapping it does
   * not touch the booking path -- but see the note on the class above: a real
   * network call here changes where the claim must be committed.
   */
  private dispatch(eventType: string, payload: unknown): Promise<void> {
    this.logger.log(`Published ${eventType}: ${JSON.stringify(payload)}`);
    return Promise.resolve();
  }
}
