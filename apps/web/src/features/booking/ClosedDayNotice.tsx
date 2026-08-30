import type { DealershipView } from '../../api/types';
import { formatMinuteOfDay, formatWeekday } from '../../lib/format';

/**
 * An empty slot list means closed, not fully booked. Rendering the opening
 * hours turns a dead end into an explanation -- and shows the timezone handling.
 */
export function ClosedDayNotice({ dealership }: { dealership: DealershipView }) {
  return (
    <div className="stack">
      <p className="muted">
        {dealership.name} is closed on that date, so there are no slots at all — this is not the
        same as being fully booked.
      </p>
      <table className="hours">
        <caption className="eyebrow" style={{ textAlign: 'left', paddingBottom: 'var(--space-2)' }}>
          Opening hours · {dealership.timezone}
        </caption>
        <tbody>
          {dealership.openingHours.map((hour) => (
            <tr key={hour.dayOfWeek}>
              <th scope="row">{formatWeekday(hour.dayOfWeek)}</th>
              <td>
                {formatMinuteOfDay(hour.openMinute)}–{formatMinuteOfDay(hour.closeMinute)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
