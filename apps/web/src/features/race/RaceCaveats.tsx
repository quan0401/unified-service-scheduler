export function RaceCaveats() {
  return (
    <details open className="panel">
      <summary className="panel__title" style={{ cursor: 'pointer' }}>
        What this screen does and does not prove
      </summary>
      <ol className="stack" style={{ paddingLeft: 'var(--space-5)' }}>
        <li>
          <strong>Losers report SLOT_UNAVAILABLE, not SLOT_CONTENDED.</strong> The winner commits
          fast enough that the others&rsquo; availability filter already sees the slot taken.{' '}
          <code>SLOT_CONTENDED</code> means all three server-side attempts hit the exclusion
          constraint — it stays near zero, and that is the point: the constraint is the backstop for
          the genuinely simultaneous window, not the everyday path.
        </li>
        <li>
          <strong>Browsers cap concurrent connections per origin</strong> at roughly six over
          HTTP/1.1. <code>fetch()</code> is called N times in one tick, but the requests leave in
          waves — see the dispatch timeline. For genuinely parallel evidence at 200 requests with
          database-level assertions, see{' '}
          <code>apps/api/test/concurrency/booking-race.e2e-spec.ts</code>.
        </li>
        <li>
          <strong>The API rate-limits 20 requests/second per IP.</strong> Above that you will see
          429s. They are the throttler working, and they dilute the measurement. Restart with{' '}
          <code>THROTTLE_BURST_LIMIT=1000 THROTTLE_SUSTAINED_LIMIT=10000</code>, or point the UI at{' '}
          <code>docker compose</code> on port 13000, which already runs with raised limits.
        </li>
      </ol>
    </details>
  );
}
