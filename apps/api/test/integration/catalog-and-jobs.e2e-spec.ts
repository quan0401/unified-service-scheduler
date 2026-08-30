/**
 * Reference-data endpoints, health surface, and the two background jobs.
 *
 * The jobs are invoked directly rather than waited for on their cron schedule --
 * a test that sleeps for a cron tick is slow and flaky, and the schedule itself
 * is framework configuration, not behaviour worth asserting.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppointmentStatus } from '@prisma/client';
import { createTestApp } from '../support/app';
import { testDb, resetData } from '../support/db';
import { createScenario, type Scenario } from '../support/fixtures';
import { OutboxRelay } from '../../src/modules/background-jobs/outbox.relay';
import { HoldSweeper } from '../../src/modules/background-jobs/hold-sweeper.service';

const MONDAY_9AM = '2026-09-07T09:00:00.000Z';
const UTC = { timezone: 'UTC' } as const;

describe('catalog, health, and background jobs', () => {
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
    scenario = await createScenario({ ...UTC, technicianCount: 1, bayCount: 1, vehicleCount: 2 });
  });

  describe('catalog', () => {
    it('lists dealerships with timezone and opening hours', async () => {
      const response = await request(app.getHttpServer()).get('/dealerships').expect(200);
      const dealership = response.body.data.find(
        (d: { id: string }) => d.id === scenario.dealershipId,
      );

      expect(dealership.timezone).toBe('UTC');
      expect(dealership.openingHours.length).toBeGreaterThan(0);
    });

    it('lists service types with their durations', async () => {
      const response = await request(app.getHttpServer()).get('/service-types').expect(200);
      const serviceType = response.body.data.find(
        (s: { id: string }) => s.id === scenario.serviceTypeId,
      );

      expect(serviceType.durationMinutes).toBeGreaterThan(0);
    });

    it('lists a customer vehicles', async () => {
      const response = await request(app.getHttpServer())
        .get(`/customers/${scenario.customerId}/vehicles`)
        .expect(200);

      expect(response.body.data).toHaveLength(2);
      expect(response.body.data[0].vin).toBeDefined();
    });

    it('returns 404 for an unknown customer rather than an empty list', async () => {
      // An empty array would be indistinguishable from "owns no vehicles",
      // which hides a client bug behind a plausible-looking response.
      const response = await request(app.getHttpServer())
        .get('/customers/00000000-0000-4000-8000-000000000000/vehicles')
        .expect(404);

      expect(response.body.error.code).toBe('CUSTOMER_NOT_FOUND');
    });

    it('rejects a non-uuid customer id', async () => {
      await request(app.getHttpServer()).get('/customers/not-a-uuid/vehicles').expect(400);
    });
  });

  describe('health and metrics', () => {
    it('reports liveness without touching the database', async () => {
      const response = await request(app.getHttpServer()).get('/health').expect(200);
      expect(response.body.data.status).toBe('ok');
    });

    it('reports readiness including database reachability', async () => {
      const response = await request(app.getHttpServer()).get('/health/ready').expect(200);
      expect(response.body.data.database).toBe('up');
    });

    it('exposes metrics in Prometheus text format, not the JSON envelope', async () => {
      const response = await request(app.getHttpServer()).get('/metrics').expect(200);

      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.text).toContain('# TYPE booking_attempts_total counter');
      expect(response.text).toContain('booking_conflicts_total');
    });
  });

  describe('outbox relay', () => {
    it('publishes pending events and marks them delivered', async () => {
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

      // Written in the same transaction as the appointment, so it exists
      // immediately and unpublished.
      expect(await testDb.outboxEvent.count({ where: { publishedAt: null } })).toBe(1);

      await app.get(OutboxRelay).publishPending();

      expect(await testDb.outboxEvent.count({ where: { publishedAt: null } })).toBe(0);
      const event = await testDb.outboxEvent.findFirstOrThrow();
      expect(event.eventType).toBe('appointment.confirmed');
      expect(event.attemptCount).toBe(1);
    });

    it('does nothing when there is no backlog', async () => {
      await expect(app.get(OutboxRelay).publishPending()).resolves.toBeUndefined();
    });
  });

  describe('hold sweeper', () => {
    it('reclaims lapsed holds and leaves live ones alone', async () => {
      const holdBody = (vehicleIndex: number) => ({
        dealershipId: scenario.dealershipId,
        customerId: scenario.customerId,
        vehicleId: scenario.vehicleIds[vehicleIndex],
        serviceTypeId: scenario.serviceTypeId,
        startAt: MONDAY_9AM,
      });

      const expired = await request(app.getHttpServer())
        .post('/holds')
        .send(holdBody(0))
        .expect(201);
      await testDb.appointment.update({
        where: { id: expired.body.data.id },
        data: { holdExpiresAt: new Date(Date.now() - 1000) },
      });

      // A live hold at a different time must survive the sweep.
      await request(app.getHttpServer())
        .post('/holds')
        .send({ ...holdBody(1), startAt: '2026-09-07T14:00:00.000Z' })
        .expect(201);

      await app.get(HoldSweeper).sweep();

      const remaining = await testDb.appointment.findMany({
        where: { status: AppointmentStatus.HELD },
      });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].startAt.toISOString()).toBe('2026-09-07T14:00:00.000Z');
    });
  });
});
