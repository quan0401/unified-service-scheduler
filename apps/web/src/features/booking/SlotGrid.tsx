import type { AvailabilityView } from '@scheduler/contracts';
import { Meter } from '../../components/Meter';
import { formatSlotTime } from '../../lib/format';

interface SlotGridProps {
  availability: AvailabilityView;
  selectedStartAt: string | null;
  onSelect: (startAt: string) => void;
}

export function SlotGrid({ availability, selectedStartAt, onSelect }: SlotGridProps) {
  const now = Date.now();

  return (
    <ul className="slot-grid">
      {availability.slots.map((slot) => {
        // The API has no rule against booking the past; this is a UI courtesy.
        const isPast = new Date(slot.startAt).getTime() < now;
        const disabled = !slot.available || isPast;
        const selected = slot.startAt === selectedStartAt;

        const modifier = selected
          ? 'slot--selected'
          : slot.available && !isPast
            ? 'slot--free'
            : '';

        return (
          <li key={slot.startAt}>
            <button
              type="button"
              className={`slot ${modifier}`}
              disabled={disabled}
              aria-pressed={selected}
              onClick={() => onSelect(slot.startAt)}
            >
              <time className="slot__time" dateTime={slot.startAt}>
                {formatSlotTime(slot.startAt, availability.timezone)}
              </time>
              {isPast ? (
                <span className="slot__note">past</span>
              ) : (
                // Both counts always show, so it is obvious *which* resource ran
                // out rather than only that the slot is unavailable.
                <span className="slot__meters">
                  <Meter label="tech" count={slot.technicianCount} />
                  <Meter label="bay" count={slot.bayCount} />
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
