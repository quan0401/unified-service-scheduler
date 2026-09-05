/**
 * Domain metrics for the booking path.
 *
 * The generic RED signals (rate, errors, duration) come from HTTP
 * instrumentation and say little about *this* system's failure mode. The
 * metrics defined here are the leading indicators specific to a contention-based
 * design:
 *
 *   - conflicts   -- how often the database refused an overlapping write.
 *     A rising rate means the resource pool is too small for demand, or that
 *     candidate selection has started clustering.
 *   - retries exhausted -- requests that lost every attempt. These are the
 *     customers who saw a failure, so this is the number that maps to harm.
 *   - attempts per booking -- the early warning. It climbs before anything is
 *     user-visible, so it is the signal to act on.
 *
 * Together they distinguish the two states an operator must tell apart:
 * "genuinely fully booked" (fine) and "fighting itself" (needs attention).
 */
import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export type BookingOutcome = 'confirmed' | 'unavailable' | 'contended' | 'replayed' | 'rejected';

@Injectable()
export class MetricsService {
  /** Every value of BookingOutcome, so the counter can be seeded with all of them. */
  private static readonly OUTCOMES: readonly BookingOutcome[] = [
    'confirmed',
    'unavailable',
    'contended',
    'replayed',
    'rejected',
  ];

  readonly registry = new Registry();

  private readonly bookingAttempts = new Counter({
    name: 'booking_attempts_total',
    help: 'Booking requests by final outcome.',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  private readonly bookingConflicts = new Counter({
    name: 'booking_conflicts_total',
    help: 'Insert attempts rejected by an exclusion constraint (SQLSTATE 23P01).',
    registers: [this.registry],
  });

  private readonly retriesExhausted = new Counter({
    name: 'booking_retry_exhausted_total',
    help: 'Bookings abandoned after exhausting every retry attempt.',
    registers: [this.registry],
  });

  private readonly attemptsPerBooking = new Histogram({
    name: 'booking_attempts_per_request',
    help: 'Database attempts needed to settle one booking request.',
    // Bucketed at the retry limit: anything at 3 is a request that nearly failed.
    buckets: [1, 2, 3],
    registers: [this.registry],
  });

  private readonly bookingDuration = new Histogram({
    name: 'booking_duration_seconds',
    help: 'End-to-end duration of a booking request.',
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  private readonly activeHolds = new Gauge({
    name: 'holds_active',
    help: 'Reservations currently occupying a slot.',
    registers: [this.registry],
  });

  constructor() {
    // Publish every outcome at zero before any request arrives.
    //
    // A labelled counter has no child until something increments it, and a
    // series that first appears mid-window is unmeasurable: `rate()` needs two
    // samples, and if the whole burst lands before the first scrape of a new
    // series, every sample in the window is identical and the rate reads zero.
    // demo/race.sh settles in under 400ms against a 5s scrape, so without this
    // the outcome panel shows nothing during precisely the event it exists to
    // show -- while booking_conflicts_total, which is unlabelled and therefore
    // exported from process start, shows the spike correctly. That asymmetry
    // was the tell.
    //
    // It also makes `sum by (outcome)` complete rather than silently missing
    // the outcomes that have not happened yet, so "no rejections" and "the
    // rejection counter does not exist" stop looking the same.
    for (const outcome of MetricsService.OUTCOMES) {
      this.bookingAttempts.inc({ outcome }, 0);
    }

    // Process-level metrics: event loop lag and heap growth are how connection
    // pool saturation actually presents under load.
    collectDefaultMetrics({ register: this.registry });
  }

  recordBooking(outcome: BookingOutcome, attempts: number, durationSeconds: number): void {
    this.bookingAttempts.inc({ outcome });
    if (attempts > 0) this.attemptsPerBooking.observe(attempts);
    this.bookingDuration.observe(durationSeconds);
  }

  /**
   * Counts a write refused by an exclusion constraint.
   *
   * Shared by bookings and holds deliberately. Both contend for the same
   * resources through the same constraints, so an operator asking "is the
   * system fighting itself?" wants the combined figure. `booking_attempts_total`
   * stays booking-only, since a hold is not yet an appointment.
   */
  recordConflict(): void {
    this.bookingConflicts.inc();
  }

  recordRetriesExhausted(): void {
    this.retriesExhausted.inc();
  }

  setActiveHolds(count: number): void {
    this.activeHolds.set(count);
  }

  scrape(): Promise<string> {
    return this.registry.metrics();
  }
}
