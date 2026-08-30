/**
 * Business-rule coverage for the booking API.
 *
 * Complements the concurrency suite: this one asserts that the right requests
 * are accepted and the wrong ones are refused for the right reason, with the
 * correct status code and error code -- the things a client actually branches on.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../support/app';
import { testDb, resetData } from '../support/db';
import { createScenario, type Scenario } from '../support/fixtures';

/** Monday 09:00 in a UTC dealership, comfortably inside 08:00-18:00. */
const MONDAY_9AM = '2026-09-07T09:00:00.000Z';
const UTC = { timezone: 'UTC' } as const;

describe('booking API', () => {
  let app: INestApplication;
  let scenario: Scenario;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await testDb.$disconnect();
  });

  beforeEach(async () => {
    await resetData();
    scenario = await createScenario({ ...UTC, technicianCount: 2, bayCount: 2, vehicleCount: 2 });
  });

  const post = (path: string, body: object) =>
    request(app.getHttpServer()).post(path).send(body);

  const bookingBody = (overrides: Record<string, unknown> = {}) => ({
    dealershipId: scenario.dealershipId,
    customerId: scenario.customerId,
    vehicleId: scenario.vehicleIds[0],
    serviceTypeId: scenario.serviceTypeId,
    startAt: MONDAY_9AM,
    ...overrides,
  });

  describe('creating an appointment', () => {
    it('associates customer, vehicle, technician, and bay on success', async () => {
      const response = await post('/appointments', bookingBody()).expect(201);
      const appointment = response.body.data;

      // Requirement 3 of the brief, asserted field by field.
      expect(appointment.customer.id).toBe(scenario.customerId);
      expect(appointment.vehicle.id).toBe(scenario.vehicleIds[0]);
      expect(scenario.technicianIds).toContain(appointment.technician.id);
      expect(scenario.bayIds).toContain(appointment.serviceBay.id);
      expect(appointment.status).toBe('CONFIRMED');
    });

    it('derives the end time from the service duration', async () => {
      const response = await post('/appointments', bookingBody()).expect(201);
      const { startAt, endAt, serviceType } = response.body.data;

      const minutes = (new Date(endAt).getTime() - new Date(startAt).getTime()) / 60_000;
      expect(minutes).toBe(serviceType.durationMinutes);
    });

    it('allows a back-to-back booking starting when the previous one ends', async () => {
      const first = await post('/appointments', bookingBody()).expect(201);

      await post(
        '/appointments',
        bookingBody({ vehicleId: scenario.vehicleIds[1], startAt: first.body.data.endAt }),
      ).expect(201);

      expect(await testDb.appointment.count()).toBe(2);
    });
  });

  describe('refusals', () => {
    it('rejects a vehicle belonging to another customer with 403', async () => {
      const other = await createScenario({ ...UTC });

      const response = await post(
        '/appointments',
        bookingBody({ vehicleId: other.vehicleIds[0] }),
      ).expect(403);

      expect(response.body.error.code).toBe('VEHICLE_NOT_OWNED');
    });

    it('rejects a time outside opening hours with 422', async () => {
      const response = await post(
        '/appointments',
        bookingBody({ startAt: '2026-09-07T03:00:00.000Z' }),
      ).expect(422);

      expect(response.body.error.code).toBe('OUTSIDE_OPENING_HOURS');
    });

    it('rejects a service that would overrun closing time', async () => {
      // 17:30 start for a 60-minute service against an 18:00 close.
      const response = await post(
        '/appointments',
        bookingBody({ startAt: '2026-09-07T17:30:00.000Z' }),
      ).expect(422);

      expect(response.body.error.code).toBe('OUTSIDE_OPENING_HOURS');
    });

    it('refuses when no technician holds the required skill', async () => {
      const unqualified = await createScenario({ ...UTC, techniciansQualified: false });

      const response = await post('/appointments', {
        dealershipId: unqualified.dealershipId,
        customerId: unqualified.customerId,
        vehicleId: unqualified.vehicleIds[0],
        serviceTypeId: unqualified.serviceTypeId,
        startAt: MONDAY_9AM,
      }).expect(409);

      expect(response.body.error.code).toBe('SLOT_UNAVAILABLE');
    });

    it('refuses when no bay is equipped for the service', async () => {
      const incapable = await createScenario({ ...UTC, baysCapable: false });

      const response = await post('/appointments', {
        dealershipId: incapable.dealershipId,
        customerId: incapable.customerId,
        vehicleId: incapable.vehicleIds[0],
        serviceTypeId: incapable.serviceTypeId,
        startAt: MONDAY_9AM,
      }).expect(409);

      expect(response.body.error.code).toBe('SLOT_UNAVAILABLE');
    });

    it('refuses when the technician is off shift at that hour', async () => {
      // Open 08:00-18:00 but every technician leaves at 10:00.
      const earlyShift = await createScenario({
        ...UTC,
        shiftStartMinute: 8 * 60,
        shiftEndMinute: 10 * 60,
      });

      const response = await post('/appointments', {
        dealershipId: earlyShift.dealershipId,
        customerId: earlyShift.customerId,
        vehicleId: earlyShift.vehicleIds[0],
        serviceTypeId: earlyShift.serviceTypeId,
        startAt: '2026-09-07T14:00:00.000Z',
      }).expect(409);

      expect(response.body.error.code).toBe('SLOT_UNAVAILABLE');
    });

    it('rejects an unknown vehicle with 404', async () => {
      const response = await post(
        '/appointments',
        bookingBody({ vehicleId: '00000000-0000-4000-8000-000000000000' }),
      ).expect(404);

      expect(response.body.error.code).toBe('VEHICLE_NOT_FOUND');
    });

    it('rejects a malformed request with 400 before touching the database', async () => {
      await post('/appointments', bookingBody({ startAt: 'not-a-timestamp' })).expect(400);
      expect(await testDb.appointment.count()).toBe(0);
    });
  });

  describe('holds', () => {
    it('blocks a competing booking while the hold is live', async () => {
      // Single technician and bay: with spare capacity a second booking would
      // legitimately succeed, and the test would prove nothing about blocking.
      const scarce = await createScenario({
        ...UTC,
        technicianCount: 1,
        bayCount: 1,
        vehicleCount: 2,
      });
      const scarceBody = (vehicleIndex: number) => ({
        dealershipId: scarce.dealershipId,
        customerId: scarce.customerId,
        vehicleId: scarce.vehicleIds[vehicleIndex],
        serviceTypeId: scarce.serviceTypeId,
        startAt: MONDAY_9AM,
      });

      await post('/holds', scarceBody(0)).expect(201);

      const response = await post('/appointments', scarceBody(1)).expect(409);
      expect(response.body.error.code).toBe('SLOT_UNAVAILABLE');
    });

    it('promotes the hold in place rather than creating a second row', async () => {
      const hold = await post('/holds', bookingBody()).expect(201);
      const holdId = hold.body.data.id;

      const confirmed = await post('/appointments', bookingBody({ holdId })).expect(201);

      expect(confirmed.body.data.id).toBe(holdId);
      expect(confirmed.body.data.status).toBe('CONFIRMED');
      expect(confirmed.body.data.holdExpiresAt).toBeNull();
      expect(await testDb.appointment.count()).toBe(1);
    });

    it('refuses to confirm a hold that has expired', async () => {
      const hold = await post('/holds', bookingBody()).expect(201);
      const holdId = hold.body.data.id;

      // Expire it in the database rather than waiting out the real TTL.
      await testDb.appointment.update({
        where: { id: holdId },
        data: { holdExpiresAt: new Date(Date.now() - 1000) },
      });

      const response = await post('/appointments', bookingBody({ holdId })).expect(409);
      expect(response.body.error.code).toBe('HOLD_EXPIRED');
    });

    it('treats an expired hold as free for a new booking', async () => {
      // Single technician and bay, so the booking MUST reuse the exact
      // resources the expired hold occupies. With spare capacity the random
      // pick would often route around the problem and the test would pass
      // while the bug remained.
      const scarce = await createScenario({
        ...UTC,
        technicianCount: 1,
        bayCount: 1,
        vehicleCount: 2,
      });
      const scarceBody = (vehicleIndex: number) => ({
        dealershipId: scarce.dealershipId,
        customerId: scarce.customerId,
        vehicleId: scarce.vehicleIds[vehicleIndex],
        serviceTypeId: scarce.serviceTypeId,
        startAt: MONDAY_9AM,
      });

      const hold = await post('/holds', scarceBody(0)).expect(201);
      await testDb.appointment.update({
        where: { id: hold.body.data.id },
        data: { holdExpiresAt: new Date(Date.now() - 1000) },
      });

      // Regression guard. The exclusion constraint predicate is
      // `status IN ('HELD','CONFIRMED')` and cannot test expiry, because an
      // exclusion predicate must be IMMUTABLE and so cannot call now(). An
      // expired hold therefore still blocks at the constraint level while
      // looking free to every query. Booking must reclaim it rather than wait
      // for the background sweeper.
      await post('/appointments', scarceBody(1)).expect(201);

      expect(await testDb.appointment.count({ where: { status: 'HELD' } })).toBe(0);
    });
  });

  describe('idempotency', () => {
    it('replays the original appointment for a repeated key', async () => {
      const key = 'idempotency-test-key';
      const send = () =>
        request(app.getHttpServer())
          .post('/appointments')
          .set('Idempotency-Key', key)
          .send(bookingBody());

      const first = await send().expect(201);
      const second = await send().expect(201);

      expect(second.body.data.id).toBe(first.body.data.id);
      expect(second.body.data.replayed).toBe(true);
      expect(await testDb.appointment.count()).toBe(1);
    });
  });

  describe('cancellation', () => {
    it('frees the slot and preserves the record for audit', async () => {
      const created = await post('/appointments', bookingBody()).expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer()).delete(`/appointments/${id}`).expect(204);

      const cancelled = await testDb.appointment.findUniqueOrThrow({ where: { id } });
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.cancelledAt).not.toBeNull();

      // The same slot is bookable again.
      await post('/appointments', bookingBody({ vehicleId: scenario.vehicleIds[1] })).expect(201);
    });

    it('refuses to cancel twice', async () => {
      const created = await post('/appointments', bookingBody()).expect(201);
      const id = created.body.data.id;

      await request(app.getHttpServer()).delete(`/appointments/${id}`).expect(204);
      const response = await request(app.getHttpServer()).delete(`/appointments/${id}`).expect(409);

      expect(response.body.error.code).toBe('APPOINTMENT_NOT_CANCELLABLE');
    });
  });

  describe('reads', () => {
    it('returns the confirmation record by id', async () => {
      const created = await post('/appointments', bookingBody()).expect(201);

      const response = await request(app.getHttpServer())
        .get(`/appointments/${created.body.data.id}`)
        .expect(200);

      expect(response.body.data.technician.name).toBeDefined();
      expect(response.body.data.serviceBay.name).toBeDefined();
    });

    it('lists appointments for a customer', async () => {
      await post('/appointments', bookingBody()).expect(201);
      await post(
        '/appointments',
        bookingBody({ vehicleId: scenario.vehicleIds[1], startAt: '2026-09-07T11:00:00.000Z' }),
      ).expect(201);

      const response = await request(app.getHttpServer())
        .get('/appointments')
        .query({ customerId: scenario.customerId })
        .expect(200);

      expect(response.body.data).toHaveLength(2);
    });
  });
});
