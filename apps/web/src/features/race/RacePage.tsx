import { useMemo, useState } from 'react';
import { api } from '../../api/endpoints';
import { Button } from '../../components/Button';
import { Callout } from '../../components/Callout';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { Field, SelectField } from '../../components/Field';
import { Spinner } from '../../components/Spinner';
import { useAsync } from '../../hooks/useAsync';
import { useResource } from '../../hooks/useResource';
import { formatSlotTime, todayInZone } from '../../lib/format';
import { CustomerField } from '../customer/CustomerField';
import { RaceCaveats } from './RaceCaveats';
import { RaceGrid } from './RaceGrid';
import { RaceSummary } from './RaceSummary';
import { RaceTimeline } from './RaceTimeline';
import { useRaceRunner } from './useRaceRunner';

/** The API's default burst ceiling. Above this, 429s dilute the measurement. */
const DEFAULT_BURST_LIMIT = 20;

interface RacePageProps {
  customerId: string;
  onCustomerChange: (id: string) => void;
}

export function RacePage({ customerId, onCustomerChange }: RacePageProps) {
  const [dealershipId, setDealershipId] = useState('');
  const [serviceTypeId, setServiceTypeId] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [date, setDate] = useState(() => todayInZone('UTC'));
  const [count, setCount] = useState(DEFAULT_BURST_LIMIT);

  const runner = useRaceRunner();
  const cancelWinner = useAsync(api.cancelAppointment);

  const dealerships = useResource('dealerships', (s) => api.dealerships(s).then((r) => r.data));
  const serviceTypes = useResource('service-types', (s) => api.serviceTypes(s).then((r) => r.data));
  const vehicles = useResource(customerId ? `vehicles:${customerId}` : null, (s) =>
    api.vehicles(customerId, s).then((r) => r.data),
  );

  const key =
    dealershipId && serviceTypeId && date
      ? `availability:${dealershipId}:${serviceTypeId}:${date}`
      : null;
  const availability = useResource(key, (s) =>
    api.availability({ dealershipId, serviceTypeId, date }, s).then((r) => r.data),
  );

  const target = useMemo(
    () => availability.data?.slots.find((slot) => slot.available) ?? null,
    [availability.data],
  );

  const timezone = availability.data?.timezone ?? 'UTC';
  const ready = Boolean(customerId && vehicleId && dealershipId && serviceTypeId && target);
  const overLimit = count > DEFAULT_BURST_LIMIT;
  const winnerId = runner.result?.attempts.find((a) => a.bucket === 'created')?.appointmentId;

  const fire = () => {
    if (!target) return;
    void runner.run(
      { dealershipId, customerId, vehicleId, serviceTypeId, startAt: target.startAt },
      count,
    );
  };

  const resetSlot = async () => {
    if (!winnerId) return;
    await cancelWinner.run(winnerId);
    runner.reset();
    availability.reload();
  };

  return (
    <>
      <header className="page__head">
        <h1 className="page__title">Concurrency</h1>
        <p className="page__lede">
          Fire N bookings at one slot simultaneously. Exactly one succeeds — not because the
          application is careful, but because PostgreSQL exclusion constraints will not accept a
          second overlapping row.
        </p>
      </header>

      <section className="panel" aria-labelledby="race-setup">
        <h2 className="panel__title" id="race-setup">
          Target
        </h2>
        <div className="grid-fields">
          <CustomerField value={customerId} onChange={onCustomerChange} />

          <SelectField
            label="Vehicle"
            value={vehicleId}
            options={vehicles.data ?? []}
            getValue={(v) => v.id}
            getLabel={(v) => `${v.year} ${v.make} ${v.model}`}
            placeholder={customerId ? 'Choose a vehicle' : 'Choose a customer first'}
            disabled={!customerId || vehicles.status !== 'success'}
            onChange={setVehicleId}
          />

          <SelectField
            label="Dealership"
            hint="Northgate Auto has exactly one bay that can do Transmission Repair."
            value={dealershipId}
            options={dealerships.data ?? []}
            getValue={(d) => d.id}
            getLabel={(d) => d.name}
            placeholder="Choose a dealership"
            onChange={setDealershipId}
          />

          <SelectField
            label="Service"
            value={serviceTypeId}
            options={serviceTypes.data ?? []}
            getValue={(s) => s.id}
            getLabel={(s) => s.name}
            placeholder="Choose a service"
            onChange={setServiceTypeId}
          />

          <Field label="Date">
            {({ id, className }) => (
              <input
                id={id}
                type="date"
                className={`${className} field__control--mono`}
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            )}
          </Field>

          <Field
            label={`Concurrent requests: ${count}`}
            hint={`Default burst limit is ${DEFAULT_BURST_LIMIT}/second per IP.`}
          >
            {({ id }) => (
              <input
                id={id}
                type="range"
                min={2}
                max={100}
                value={count}
                onChange={(event) => setCount(Number(event.target.value))}
              />
            )}
          </Field>
        </div>

        <div className="stack" style={{ marginTop: 'var(--space-5)' }}>
          {availability.status === 'pending' ? <Spinner label="Finding a free slot" /> : null}
          {availability.status === 'error' ? (
            <ErrorState error={availability.error} onRetry={availability.reload} />
          ) : null}
          {availability.status === 'success' && !target ? (
            <EmptyState>No free slot on that date to race for.</EmptyState>
          ) : null}
          {target ? (
            <p className="mono">
              Target slot: <strong>{formatSlotTime(target.startAt, timezone)}</strong> {timezone}
            </p>
          ) : null}

          {overLimit ? (
            <Callout
              tone="warn"
              title={`N = ${count} exceeds the default burst limit of ${DEFAULT_BURST_LIMIT}/second`}
            >
              <p>
                Expect roughly {count - DEFAULT_BURST_LIMIT} responses in the rate-limited bucket.
                They are the throttler, not booking conflicts. For a clean run, restart the API with{' '}
                <code>THROTTLE_BURST_LIMIT=1000 THROTTLE_SUSTAINED_LIMIT=10000</code>, or point the
                UI at <code>docker compose</code> on port 13000, which already sets raised limits.
              </p>
            </Callout>
          ) : null}

          <div className="cluster">
            <Button variant="primary" onClick={fire} loading={runner.running} disabled={!ready}>
              Fire {count} concurrent bookings
            </Button>
            {winnerId ? (
              <Button
                variant="danger"
                onClick={resetSlot}
                loading={cancelWinner.state.status === 'pending'}
              >
                Cancel the winner and reset
              </Button>
            ) : null}
          </div>
        </div>
      </section>

      {runner.error ? (
        <div style={{ marginTop: 'var(--space-5)' }}>
          <ErrorState error={runner.error} />
        </div>
      ) : null}

      {runner.result ? (
        <>
          <section className="panel" aria-labelledby="race-result">
            <h2 className="panel__title" id="race-result">
              Outcome
            </h2>
            <RaceSummary result={runner.result} timezone={timezone} />
          </section>

          <section className="panel" aria-labelledby="race-detail">
            <h2 className="panel__title" id="race-detail">
              Per request
            </h2>
            <RaceGrid attempts={runner.result.attempts} />
            <h3 className="eyebrow" style={{ margin: 'var(--space-5) 0 var(--space-2)' }}>
              Dispatch timeline
            </h3>
            <RaceTimeline attempts={runner.result.attempts} totalMs={runner.result.totalMs} />
          </section>
        </>
      ) : null}

      <RaceCaveats />
    </>
  );
}
