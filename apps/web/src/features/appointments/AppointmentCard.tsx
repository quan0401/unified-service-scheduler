import { useState } from 'react';
import { api } from '../../api/endpoints';
import type { AppointmentRecord } from '../../api/types';
import { Button } from '../../components/Button';
import { CopyField } from '../../components/CopyField';
import { ErrorState } from '../../components/ErrorState';
import { StatusPill } from '../../components/StatusPill';
import { useAsync } from '../../hooks/useAsync';
import { formatSlotDate, formatSlotTime } from '../../lib/format';

interface AppointmentCardProps {
  record: AppointmentRecord;
  onChanged: () => void;
}

export function AppointmentCard({ record, onChanged }: AppointmentCardProps) {
  const cancel = useAsync(api.cancelAppointment);
  const [dismissed, setDismissed] = useState(false);
  const zone = record.dealership.timezone;

  const onCancel = async () => {
    setDismissed(false);
    const result = await cancel.run(record.id);
    // 204 resolves with undefined data, so success is "no error was thrown".
    if (result !== null) onChanged();
  };

  const closed = record.status === 'CANCELLED' || record.status === 'COMPLETED';

  return (
    <article
      className="panel"
      style={{ marginTop: 0, opacity: record.status === 'CANCELLED' ? 0.6 : 1 }}
    >
      <div className="cluster" style={{ justifyContent: 'space-between' }}>
        <div className="cluster">
          <StatusPill status={record.status} />
          <strong className="mono">
            {formatSlotDate(record.startAt, zone)} · {formatSlotTime(record.startAt, zone)}–
            {formatSlotTime(record.endAt, zone)}
          </strong>
        </div>
        <Button
          variant="danger"
          onClick={onCancel}
          loading={cancel.state.status === 'pending'}
          disabled={closed}
        >
          Cancel
        </Button>
      </div>

      <dl className="record" style={{ marginTop: 'var(--space-4)' }}>
        <dt>Id</dt>
        <dd>
          <CopyField value={record.id} />
        </dd>
        <dt>Vehicle</dt>
        <dd>
          {record.vehicle.year} {record.vehicle.make} {record.vehicle.model}
        </dd>
        <dt>Service</dt>
        <dd>{record.serviceType.name}</dd>
        <dt>Technician</dt>
        <dd>{record.technician.name}</dd>
        <dt>Bay</dt>
        <dd>
          {record.serviceBay.name} · {record.dealership.name}
        </dd>
        {record.cancelledAt ? (
          <>
            <dt>Cancelled</dt>
            <dd>{record.cancelledAt}</dd>
          </>
        ) : null}
      </dl>

      {cancel.state.status === 'error' && !dismissed ? (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <ErrorState error={cancel.state.error} onRetry={() => setDismissed(true)} />
        </div>
      ) : null}
    </article>
  );
}
