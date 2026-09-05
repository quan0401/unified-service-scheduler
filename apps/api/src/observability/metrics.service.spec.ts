import { MetricsService } from './metrics.service';
import type { BookingOutcome } from './metrics.service';

const OUTCOMES: BookingOutcome[] = ['confirmed', 'unavailable', 'contended', 'replayed', 'rejected'];

describe('MetricsService', () => {
  it('publishes every booking outcome at zero before any request arrives', async () => {
    // Arrange
    const metrics = new MetricsService();

    // Act
    const scrape = await metrics.scrape();

    // Assert -- a label that only appears on first increment cannot be rated
    // over the window in which it appeared, which is the window that matters.
    for (const outcome of OUTCOMES) {
      expect(scrape).toContain(`booking_attempts_total{outcome="${outcome}"} 0`);
    }
  });

  it('counts a booking against its outcome without disturbing the others', async () => {
    // Arrange
    const metrics = new MetricsService();

    // Act
    metrics.recordBooking('contended', 3, 0.25);

    // Assert
    const scrape = await metrics.scrape();
    expect(scrape).toContain('booking_attempts_total{outcome="contended"} 1');
    expect(scrape).toContain('booking_attempts_total{outcome="confirmed"} 0');
  });

  it('exports the process metrics the runtime dashboard reads', async () => {
    // Arrange
    const metrics = new MetricsService();

    // Act
    const scrape = await metrics.scrape();

    // Assert -- these are the series the Grafana runtime row queries by name,
    // so a prom-client upgrade that renamed one would fail here rather than
    // silently emptying a panel.
    for (const name of [
      'nodejs_gc_duration_seconds',
      'nodejs_heap_size_used_bytes',
      'nodejs_heap_space_size_used_bytes',
      'nodejs_eventloop_lag_p99_seconds',
      'nodejs_active_handles_total',
      'process_resident_memory_bytes',
      // process_open_fds and process_max_fds are deliberately absent: prom-client
      // collects them from /proc, so they exist in the container and not on a
      // macOS `pnpm start:dev`. Asserting them here would fail by platform.
    ]) {
      expect(scrape).toContain(name);
    }
  });

  it('shares the conflict counter between bookings and holds', async () => {
    // Arrange
    const metrics = new MetricsService();

    // Act
    metrics.recordConflict();
    metrics.recordConflict();
    metrics.recordRetriesExhausted();
    metrics.setActiveHolds(4);

    // Assert
    const scrape = await metrics.scrape();
    expect(scrape).toContain('booking_conflicts_total 2');
    expect(scrape).toContain('booking_retry_exhausted_total 1');
    expect(scrape).toContain('holds_active 4');
  });
});
