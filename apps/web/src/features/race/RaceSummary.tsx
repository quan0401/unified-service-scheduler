import { CopyField } from '../../components/CopyField';
import { formatSlotTime } from '../../lib/format';
import { BUCKET_META, BUCKET_ORDER } from './raceBuckets';
import type { RaceResult } from './useRaceRunner';

export function RaceSummary({ result, timezone }: { result: RaceResult; timezone: string }) {
  const confirmed = result.confirmedOnServer;

  return (
    <div className="stack" role="status" aria-live="polite">
      <div className="race-summary">
        {BUCKET_ORDER.map((bucket) => {
          const meta = BUCKET_META[bucket];
          const count = result.counts[bucket];
          if (count === 0 && bucket === 'hold-expired') return null;

          return (
            <div
              key={bucket}
              className={`race-stat race-stat--${meta.tone}${
                bucket === 'throttled' ? ' race-stat--separated' : ''
              }`}
              title={meta.description}
            >
              <p className="race-stat__value">{count}</p>
              <p className="race-stat__label">{meta.label}</p>
            </div>
          );
        })}
      </div>

      {result.counts.throttled > 0 ? (
        <p className="callout callout--info">
          {result.counts.throttled} of these were rejected by the per-IP rate limiter, not by the
          booking constraint. They say nothing about concurrency — raise the throttle and run again
          for a clean measurement.
        </p>
      ) : null}

      {confirmed ? (
        <p className="race-truth">
          The server holds <strong className="mono">{confirmed.length} CONFIRMED</strong>{' '}
          appointment{confirmed.length === 1 ? '' : 's'} at that slot
          {confirmed[0] ? (
            <>
              {' '}
              <span className="mono">
                ({formatSlotTime(confirmed[0].startAt, timezone)} {timezone})
              </span>
            </>
          ) : null}
          . <span className="muted">Counted by querying the API, not by adding up the tiles.</span>
          {confirmed[0] ? (
            <>
              <br />
              <CopyField label="id" value={confirmed[0].id} />
            </>
          ) : null}
        </p>
      ) : null}

      <p className="field__hint mono">
        {result.attempts.length} requests settled in {Math.round(result.totalMs)} ms
      </p>
    </div>
  );
}
