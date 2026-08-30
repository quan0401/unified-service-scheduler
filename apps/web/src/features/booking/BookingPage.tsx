import { useMemo, useState } from 'react';
import { createHoldSchema } from '@scheduler/contracts';
import { api } from '../../api/endpoints';
import type { BookedRecord, HoldRecord } from '../../api/types';
import { Button } from '../../components/Button';
import { Callout } from '../../components/Callout';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { Field, SelectField } from '../../components/Field';
import { Spinner } from '../../components/Spinner';
import { useAsync } from '../../hooks/useAsync';
import { useResource } from '../../hooks/useResource';
import { newId } from '../../lib/ids';
import { formatDuration, todayInZone } from '../../lib/format';
import { CustomerField } from '../customer/CustomerField';
import { BookingReceipt } from './BookingReceipt';
import { ClosedDayNotice } from './ClosedDayNotice';
import { HoldPanel } from './HoldPanel';
import { SlotGrid } from './SlotGrid';

interface BookingPageProps {
  customerId: string;
  onCustomerChange: (id: string) => void;
}

export function BookingPage({ customerId, onCustomerChange }: BookingPageProps) {
  const [dealershipId, setDealershipId] = useState('');
  const [serviceTypeId, setServiceTypeId] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [date, setDate] = useState(() => todayInZone('UTC'));
  const [reserveFirst, setReserveFirst] = useState(true);

  const [selectedStartAt, setSelectedStartAt] = useState<string | null>(null);
  const [hold, setHold] = useState<{ record: HoldRecord; receivedAt: number } | null>(null);
  const [booked, setBooked] = useState<BookedRecord | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => newId());
  const [validationError, setValidationError] = useState<string | null>(null);

  const dealerships = useResource('dealerships', (s) => api.dealerships(s).then((r) => r.data));
  const serviceTypes = useResource('service-types', (s) => api.serviceTypes(s).then((r) => r.data));
  const vehicles = useResource(customerId ? `vehicles:${customerId}` : null, (s) =>
    api.vehicles(customerId, s).then((r) => r.data),
  );

  const availabilityKey =
    dealershipId && serviceTypeId && date
      ? `availability:${dealershipId}:${serviceTypeId}:${date}`
      : null;
  const availability = useResource(availabilityKey, (s) =>
    api.availability({ dealershipId, serviceTypeId, date }, s).then((r) => r.data),
  );

  const dealership = useMemo(
    () => dealerships.data?.find((d) => d.id === dealershipId) ?? null,
    [dealerships.data, dealershipId],
  );

  const holdCall = useAsync(api.createHold);
  const bookCall = useAsync(api.createAppointment);

  const resetFlow = () => {
    setSelectedStartAt(null);
    setHold(null);
    setBooked(null);
    setValidationError(null);
    setIdempotencyKey(newId());
    holdCall.reset();
    bookCall.reset();
  };

  const buildBody = (startAt: string) => ({
    dealershipId,
    customerId,
    vehicleId,
    serviceTypeId,
    startAt,
  });

  const onSelectSlot = async (startAt: string) => {
    setSelectedStartAt(startAt);
    setValidationError(null);
    setBooked(null);

    const body = buildBody(startAt);

    // The one runtime use of @scheduler/contracts: the browser validates
    // against the identical Zod declaration the server validates against, so a
    // shape change is a compile-or-parse failure here rather than a 400 later.
    const parsed = createHoldSchema.safeParse(body);
    if (!parsed.success) {
      setValidationError(parsed.error.issues.map((i) => i.message).join(' · '));
      return;
    }

    if (!reserveFirst) {
      const record = await bookCall.run(body, { idempotencyKey });
      if (record) setBooked(record.data);
      return;
    }

    const created = await holdCall.run(parsed.data);
    if (created) setHold({ record: created.data, receivedAt: Date.now() });
  };

  const confirm = async () => {
    if (!hold) return;
    const record = await bookCall.run(
      { ...buildBody(hold.record.startAt), holdId: hold.record.id },
      { idempotencyKey },
    );
    if (record) {
      setBooked(record.data);
      setHold(null);
    }
  };

  const replay = async () => {
    if (!booked) return;
    const record = await bookCall.run(
      { ...buildBody(booked.startAt), holdId: booked.id },
      { idempotencyKey },
    );
    if (record) setBooked(record.data);
  };

  const releaseHold = () => {
    setHold(null);
    setSelectedStartAt(null);
    holdCall.reset();
    availability.reload();
  };

  const mutationError = holdCall.state.error ?? bookCall.state.error;

  return (
    <>
      <header className="page__head">
        <h1 className="page__title">Book a service appointment</h1>
        <p className="page__lede">
          Availability is advisory — the grid shows what was free when it loaded. Booking re-checks
          atomically, so a slot shown as free can still come back as a conflict. That is the design,
          not a bug.
        </p>
      </header>

      <section className="panel" aria-labelledby="selection-heading">
        <h2 className="panel__title" id="selection-heading">
          1 · What, where and when
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
            value={dealershipId}
            options={dealerships.data ?? []}
            getValue={(d) => d.id}
            getLabel={(d) => `${d.name} · ${d.timezone}`}
            placeholder="Choose a dealership"
            onChange={(id) => {
              setDealershipId(id);
              resetFlow();
            }}
          />

          <SelectField
            label="Service"
            value={serviceTypeId}
            options={serviceTypes.data ?? []}
            getValue={(s) => s.id}
            getLabel={(s) => `${s.name} · ${formatDuration(s.durationMinutes)}`}
            placeholder="Choose a service"
            onChange={(id) => {
              setServiceTypeId(id);
              resetFlow();
            }}
          />

          <Field label="Date" hint={dealership ? `Local to ${dealership.timezone}` : undefined}>
            {({ id, className }) => (
              <input
                id={id}
                type="date"
                className={`${className} field__control--mono`}
                value={date}
                onChange={(event) => {
                  setDate(event.target.value);
                  resetFlow();
                }}
              />
            )}
          </Field>
        </div>

        {vehicles.status === 'error' ? (
          <div style={{ marginTop: 'var(--space-4)' }}>
            <ErrorState error={vehicles.error} onRetry={vehicles.reload} />
          </div>
        ) : null}

        <p style={{ marginTop: 'var(--space-4)' }}>
          <label className="cluster">
            <input
              type="checkbox"
              checked={reserveFirst}
              onChange={(event) => {
                setReserveFirst(event.target.checked);
                resetFlow();
              }}
            />
            <span>
              Reserve the slot first <span className="muted">(hold, then confirm)</span>
            </span>
          </label>
        </p>
      </section>

      <section className="panel" aria-labelledby="availability-heading">
        <div className="cluster" style={{ justifyContent: 'space-between' }}>
          <h2 className="panel__title" id="availability-heading" style={{ margin: 0 }}>
            2 · Availability
          </h2>
          <Button variant="ghost" onClick={availability.reload} disabled={!availabilityKey}>
            Refresh
          </Button>
        </div>

        <div style={{ marginTop: 'var(--space-4)' }}>
          {availability.status === 'idle' ? (
            <EmptyState>Choose a dealership, a service and a date.</EmptyState>
          ) : null}
          {availability.status === 'pending' ? <Spinner label="Checking availability" /> : null}
          {availability.status === 'error' ? (
            <ErrorState error={availability.error} onRetry={availability.reload} />
          ) : null}
          {availability.status === 'success' ? (
            availability.data.slots.length === 0 && dealership ? (
              <ClosedDayNotice dealership={dealership} />
            ) : (
              <div className="stack">
                <p className="muted">
                  {availability.data.slots.filter((s) => s.available).length} of{' '}
                  {availability.data.slots.length} slots free ·{' '}
                  {formatDuration(availability.data.durationMinutes)} · {availability.data.timezone}
                </p>
                <SlotGrid
                  availability={availability.data}
                  selectedStartAt={selectedStartAt}
                  onSelect={onSelectSlot}
                />
              </div>
            )
          ) : null}
        </div>
      </section>

      {validationError ? (
        <div style={{ marginTop: 'var(--space-5)' }}>
          <Callout tone="error" title="The request is incomplete">
            <p>{validationError}</p>
          </Callout>
        </div>
      ) : null}

      {mutationError ? (
        <div style={{ marginTop: 'var(--space-5)' }}>
          <ErrorState
            error={mutationError}
            onRetry={() => {
              holdCall.reset();
              bookCall.reset();
              availability.reload();
              setSelectedStartAt(null);
              setHold(null);
            }}
          />
        </div>
      ) : null}

      {hold ? (
        <section className="panel" aria-labelledby="hold-heading">
          <h2 className="panel__title" id="hold-heading">
            3 · Your reservation
          </h2>
          <HoldPanel
            hold={hold.record}
            receivedAt={hold.receivedAt}
            idempotencyKey={idempotencyKey}
            confirming={bookCall.state.status === 'pending'}
            onConfirm={confirm}
            onRelease={releaseHold}
          />
        </section>
      ) : null}

      {booked ? (
        <section className="panel" aria-labelledby="receipt-heading">
          <h2 className="panel__title" id="receipt-heading">
            Confirmed
          </h2>
          <BookingReceipt
            record={booked}
            holdId={hold?.record.id ?? booked.id}
            replaying={bookCall.state.status === 'pending'}
            onReplay={replay}
            onStartOver={() => {
              resetFlow();
              availability.reload();
            }}
          />
        </section>
      ) : null}
    </>
  );
}
