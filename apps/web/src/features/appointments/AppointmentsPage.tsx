import { useState } from 'react';
import { api } from '../../api/endpoints';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { Field } from '../../components/Field';
import { Spinner } from '../../components/Spinner';
import { useAsync } from '../../hooks/useAsync';
import { useResource } from '../../hooks/useResource';
import { CustomerField } from '../customer/CustomerField';
import { AppointmentCard } from './AppointmentCard';

interface AppointmentsPageProps {
  customerId: string;
  onCustomerChange: (id: string) => void;
}

export function AppointmentsPage({ customerId, onCustomerChange }: AppointmentsPageProps) {
  const [lookupId, setLookupId] = useState('');
  const lookup = useAsync(api.getAppointment);

  const list = useResource(customerId ? `appointments:${customerId}` : null, (s) =>
    api.listAppointments(customerId, s).then((r) => r.data),
  );

  return (
    <>
      <header className="page__head">
        <h1 className="page__title">Appointments</h1>
        <p className="page__lede">
          Cancelling is a status change, not a delete — the record stays and the slot is freed.
          There is no optimistic update here on purpose: the server is the authority.
        </p>
      </header>

      <section className="panel" aria-labelledby="list-heading">
        <h2 className="panel__title" id="list-heading">
          By customer
        </h2>
        <div className="grid-fields">
          <CustomerField value={customerId} onChange={onCustomerChange} />
        </div>

        <div className="stack" style={{ marginTop: 'var(--space-5)' }}>
          {list.status === 'idle' ? <EmptyState>Choose a customer.</EmptyState> : null}
          {list.status === 'pending' ? <Spinner label="Loading appointments" /> : null}
          {list.status === 'error' ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
          {list.status === 'success' && list.data.length === 0 ? (
            <EmptyState>No appointments for this customer yet.</EmptyState>
          ) : null}
          {list.status === 'success'
            ? list.data.map((record) => (
                <AppointmentCard key={record.id} record={record} onChanged={list.reload} />
              ))
            : null}
        </div>
      </section>

      <section className="panel" aria-labelledby="lookup-heading">
        <h2 className="panel__title" id="lookup-heading">
          Look up by id
        </h2>
        <div className="grid-fields">
          <Field label="Appointment ID">
            {({ id, className }) => (
              <input
                id={id}
                className={`${className} field__control--mono`}
                value={lookupId}
                placeholder="00000000-0000-0000-0000-000000000000"
                onChange={(event) => setLookupId(event.target.value.trim())}
              />
            )}
          </Field>
        </div>
        <p style={{ marginTop: 'var(--space-4)' }}>
          <Button
            variant="secondary"
            onClick={() => void lookup.run(lookupId)}
            loading={lookup.state.status === 'pending'}
            disabled={!lookupId}
          >
            Look up
          </Button>
        </p>

        <div className="stack" style={{ marginTop: 'var(--space-4)' }}>
          {lookup.state.status === 'error' ? <ErrorState error={lookup.state.error} /> : null}
          {lookup.state.status === 'success' ? (
            <AppointmentCard
              record={lookup.state.data.data}
              onChanged={() => void lookup.run(lookupId)}
            />
          ) : null}
        </div>
      </section>
    </>
  );
}
