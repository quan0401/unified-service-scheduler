import type { RaceAttempt } from './useRaceRunner';

/**
 * One bar per attempt, dispatched to settled. This is the honest part: browsers
 * cap concurrent HTTP/1.1 connections per origin at roughly six, so the
 * requests leave in waves rather than all at once. The stair-step is visible
 * here rather than hidden.
 */
export function RaceTimeline({
  attempts,
  totalMs,
}: {
  attempts: readonly RaceAttempt[];
  totalMs: number;
}) {
  const scale = totalMs > 0 ? 100 / totalMs : 0;

  return (
    <div className="timeline" aria-hidden="true">
      {attempts.map((attempt) => (
        <div className="timeline__row" key={attempt.index}>
          <div
            className={`timeline__bar timeline__bar--${attempt.bucket}`}
            style={{
              left: `${attempt.dispatchedAt * scale}%`,
              width: `${Math.max(0.5, (attempt.settledAt - attempt.dispatchedAt) * scale)}%`,
            }}
          />
        </div>
      ))}
    </div>
  );
}
