/**
 * Availability endpoint behaviour against a real database.
 *
 * The slot *shape* is covered by the generator's unit tests; what needs a
 * database is occupancy -- that the grid reflects qualification, capability,
 * shift coverage, and existing bookings.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../support/app';
import { testDb, resetData } from '../support/db';
import { createScenario, type Scenario } from '../support/fixtures';

const MONDAY = '2026-09-07';
const MONDAY_9AM = '2026-09-07T09:00:00.000Z';
const UTC = { timezone: 'UTC' } as const;

describe('availability API', () => {
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

  const getAvailability = (overrides: Record<string, string> = {}) =>
    request(app.getHttpServer())
      .get('/availability')
      .query({
        dealershipId: scenario.dealershipId,
        serviceTypeId: scenario.serviceTypeId,
        date: MONDAY,
        ...overrides,
      });

  it('reports free capacity for both resource types', async () => {
    const response = await getAvailability().expect(200);
    const slot = response.body.data.slots[0];

    expect(slot.technicianCount).toBe(2);
    expect(slot.bayCount).toBe(2);
    expect(slot.available).toBe(true);
  });

  it('decrements the affected slot after a booking', async () => {
    await request(app.getHttpServer())
      .post('/appointments')
      .send({
        dealershipId: scenario.dealershipId,
        customerId: scenario.customerId,
        vehicleId: scenario.vehicleIds[0],
        serviceTypeId: scenario.serviceTypeId,
        startAt: MONDAY_9AM,
      })
      .expect(201);

    const response = await getAvailability().expect(200);
    const booked = response.body.data.slots.find(
      (slot: { startAt: string }) => slot.startAt === MONDAY_9AM,
    );

    expect(booked.technicianCount).toBe(1);
    expect(booked.bayCount).toBe(1);
    expect(booked.available).toBe(true); // Capacity remains, just less of it.
  });

  it('marks a slot unavailable once the last bay is taken', async () => {
    const scarce = await createScenario({ ...UTC, technicianCount: 3, bayCount: 1 });

    await request(app.getHttpServer())
      .post('/appointments')
      .send({
        dealershipId: scarce.dealershipId,
        customerId: scarce.customerId,
        vehicleId: scarce.vehicleIds[0],
        serviceTypeId: scarce.serviceTypeId,
        startAt: MONDAY_9AM,
      })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get('/availability')
      .query({
        dealershipId: scarce.dealershipId,
        serviceTypeId: scarce.serviceTypeId,
        date: MONDAY,
      })
      .expect(200);

    const booked = response.body.data.slots.find(
      (slot: { startAt: string }) => slot.startAt === MONDAY_9AM,
    );
    expect(booked.bayCount).toBe(0);
    expect(booked.available).toBe(false);
  });

  it('reports no qualified technicians when none hold the skill', async () => {
    const unqualified = await createScenario({ ...UTC, techniciansQualified: false });

    const response = await request(app.getHttpServer())
      .get('/availability')
      .query({
        dealershipId: unqualified.dealershipId,
        serviceTypeId: unqualified.serviceTypeId,
        date: MONDAY,
      })
      .expect(200);

    expect(response.body.data.slots.every((slot: { available: boolean }) => !slot.available)).toBe(
      true,
    );
  });

  it('returns an empty grid on a day the dealership is closed', async () => {
    const weekdaysOnly = await createScenario({ ...UTC });
    await testDb.openingHour.deleteMany({
      where: { dealershipId: weekdaysOnly.dealershipId, dayOfWeek: 7 },
    });

    const response = await request(app.getHttpServer())
      .get('/availability')
      .query({
        dealershipId: weekdaysOnly.dealershipId,
        serviceTypeId: weekdaysOnly.serviceTypeId,
        date: '2026-09-13', // Sunday
      })
      .expect(200);

    expect(response.body.data.slots).toEqual([]);
  });

  it('excludes slots where the technician is off shift', async () => {
    const earlyShift = await createScenario({
      ...UTC,
      shiftStartMinute: 8 * 60,
      shiftEndMinute: 10 * 60,
    });

    const response = await request(app.getHttpServer())
      .get('/availability')
      .query({
        dealershipId: earlyShift.dealershipId,
        serviceTypeId: earlyShift.serviceTypeId,
        date: MONDAY,
      })
      .expect(200);

    const afternoon = response.body.data.slots.find(
      (slot: { startAt: string }) => slot.startAt === '2026-09-07T14:00:00.000Z',
    );
    expect(afternoon.technicianCount).toBe(0);
  });

  it('reports the dealership timezone alongside the grid', async () => {
    const london = await createScenario({ timezone: 'Europe/London' });

    const response = await request(app.getHttpServer())
      .get('/availability')
      .query({
        dealershipId: london.dealershipId,
        serviceTypeId: london.serviceTypeId,
        date: MONDAY,
      })
      .expect(200);

    expect(response.body.data.timezone).toBe('Europe/London');
    // 08:00 London in September is 07:00Z.
    expect(response.body.data.slots[0].startAt).toBe('2026-09-07T07:00:00.000Z');
  });

  describe('validation', () => {
    it('rejects a malformed date', async () => {
      await getAvailability({ date: '07-09-2026' }).expect(400);
    });

    it('returns 404 for an unknown dealership', async () => {
      const response = await getAvailability({
        dealershipId: '00000000-0000-4000-8000-000000000000',
      }).expect(404);
      expect(response.body.error.code).toBe('DEALERSHIP_NOT_FOUND');
    });

    it('returns 404 for an unknown service type', async () => {
      const response = await getAvailability({
        serviceTypeId: '00000000-0000-4000-8000-000000000000',
      }).expect(404);
      expect(response.body.error.code).toBe('SERVICE_TYPE_NOT_FOUND');
    });
  });
});
