import { Button } from '../../components/Button';
import { CopyField } from '../../components/CopyField';
import { formatCountdown, formatSlotTime } from '../../lib/format';
import { useCountdown } from '../../hooks/useCountdown';
import type { HoldRecord } from '../../api/types';

interface HoldPanelProps {
  hold: HoldRecord;
  receivedAt: number;
  idempotencyKey: string;
  confirming: boolean;
  onConfirm: () => void;
  onRelease: () => void;
}

const URGENT_MS = 30_000;

export function HoldPanel({
  hold,
  receivedAt,
  idempotencyKey,
  confirming,
  onConfirm,
  onRelease,
}: HoldPanelProps) {
  const totalMs = hold.expiresInSeconds * 1000;
  const { remainingMs, fraction, expired } = useCountdown(receivedAt + totalMs, totalMs);
  const urgent = remainingMs <= URGENT_MS;

  return (
    <div className="stack">
      <p className="eyebrow">Slot reserved</p>
      <p>
        <strong className="mono">
          {formatSlotTime(hold.startAt, hold.dealership.timezone)}–
          {formatSlotTime(hold.endAt, hold.dealership.timezone)}
        </strong>{' '}
        <span className="muted">{hold.dealership.timezone}</span>
      </p>

      <div>
        <p className={`hold-clock${urgent ? ' hold-clock--urgent' : ''}`}>
          {expired ? '0:00' : formatCountdown(remainingMs)}
        </p>
        <div
          className={`hold-bar${urgent ? ' hold-bar--urgent' : ''}`}
          role="progressbar"
          aria-label="Time left on this reservation"
          aria-valuenow={Math.ceil(remainingMs / 1000)}
          aria-valuemin={0}
          aria-valuemax={hold.expiresInSeconds}
        >
          <div className="hold-bar__fill" style={{ ['--progress' as string]: String(fraction) }} />
        </div>
        <p className="field__hint">
          Server expiry {hold.holdExpiresAt ?? 'unknown'} — the server clock is the authority; this
          counter is only a display.
        </p>
      </div>

      {expired ? (
        <p className="muted">This reservation lapsed. The slot has gone back on sale.</p>
      ) : null}

      <div className="cluster">
        <Button variant="primary" onClick={onConfirm} loading={confirming} disabled={expired}>
          Confirm booking
        </Button>
        <Button variant="ghost" onClick={onRelease}>
          {expired ? 'Choose another time' : 'Release'}
        </Button>
      </div>

      <CopyField label="Idempotency-Key" value={idempotencyKey} />
    </div>
  );
}
