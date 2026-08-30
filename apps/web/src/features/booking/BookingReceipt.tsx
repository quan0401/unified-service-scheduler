import { Button } from '../../components/Button';
import { CopyField } from '../../components/CopyField';
import { StatusPill } from '../../components/StatusPill';
import { formatSlotDate, formatSlotTime } from '../../lib/format';
import type { BookedRecord } from '../../api/types';

interface BookingReceiptProps {
  record: BookedRecord;
  /** The hold this was promoted from, if there was one. */
  holdId: string | null;
  replaying: boolean;
  onReplay: () => void;
  onStartOver: () => void;
}

/**
 * Requirement 3 on one card: the appointment associates a customer, a vehicle,
 * a technician and a service bay.
 */
export function BookingReceipt({
  record,
  holdId,
  replaying,
  onReplay,
  onStartOver,
}: BookingReceiptProps) {
  const zone = record.dealership.timezone;

  return (
    <div className="stack">
      <div className="cluster">
        <StatusPill status={record.status} />
        {record.replayed ? <span className="pill pill--completed">REPLAYED</span> : null}
      </div>

      <dl className="record">
        <dt>Appointment</dt>
        <dd>
          <CopyField value={record.id} />
        </dd>

        <dt>When</dt>
        <dd>
          {formatSlotDate(record.startAt, zone)} · {formatSlotTime(record.startAt, zone)}–
          {formatSlotTime(record.endAt, zone)} {zone}
        </dd>

        <dt>Customer</dt>
        <dd>
          {record.customer.name} · {record.customer.email}
        </dd>

        <dt>Vehicle</dt>
        <dd>
          {record.vehicle.year} {record.vehicle.make} {record.vehicle.model} · {record.vehicle.vin}
        </dd>

        <dt>Service</dt>
        <dd>
          {record.serviceType.name} · {record.serviceType.durationMinutes} min
        </dd>

        <dt>Technician</dt>
        <dd>{record.technician.name}</dd>

        <dt>Bay</dt>
        <dd>
          {record.serviceBay.name} · {record.dealership.name}
        </dd>
      </dl>

      {holdId && holdId === record.id ? (
        <p className="field__hint">
          This id is the same row as the hold — the reservation was promoted in place, so the slot
          was never momentarily released.
        </p>
      ) : null}

      <div className="cluster">
        <Button variant="secondary" onClick={onReplay} loading={replaying}>
          Send it again with the same key
        </Button>
        <Button variant="ghost" onClick={onStartOver}>
          Book another
        </Button>
      </div>
      <p className="field__hint">
        Replaying returns the identical id with <code>replayed: true</code> rather than creating a
        second appointment.
      </p>
    </div>
  );
}
