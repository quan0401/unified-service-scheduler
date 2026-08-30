/**
 * The decisive test.
 *
 * Requirement 2 of the brief -- "check availability before confirming" -- is
 * only meaningfully satisfied if it holds under concurrency. A sequential test
 * proves nothing here: the naive check-then-act implementation this design
 * exists to avoid passes every sequential test ever written and fails the
 * moment two customers click at once.
 *
 * So this suite fires many genuinely simultaneous bookings at a single slot
 * backed by a single bay and asserts the only acceptable outcome: one winner,
 * everyone else refused, and exactly one row in the table.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../support/app';
import { testDb, resetData } from '../support/db';
import { createScenario, createVehicles, type Scenario } from '../support/fixtures';

/**
 * A Monday at 09:00. Scenarios below pin the dealership to UTC so this instant
 * is unambiguously mid-morning -- timezone behaviour is covered by the slot
 * generator's unit tests and would only obscure what this suite measures.
 */
const CONTENDED_SLOT = '2026-09-07T09:00:00.000Z';
const UTC_DEALERSHIP = { timezone: 'UTC' } as const;

/**
 * Enough concurrency that any real race window is hit reliably. Small values
 * can pass against a broken implementation purely by scheduling luck.
 */
const CONCURRENT_BOOKERS = 200;

describe('concurrent booking of a single slot', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await testDb.$disconnect();
  });

  beforeEach(async () => {
    await resetData();
  });

  /** Fires every request together so they contend rather than queue politely. */
  async function stampede(
    scenario: Scenario,
    vehicleIds: string[],
    startAt = CONTENDED_SLOT,
  ): Promise<number[]> {
    const server = app.getHttpServer();
    const responses = await Promise.all(
      vehicleIds.map((vehicleId) =>
        request(server)
          .post('/appointments')
          .send({
            dealershipId: scenario.dealershipId,
            customerId: scenario.customerId,
            vehicleId,
            serviceTypeId: scenario.serviceTypeId,
            startAt,
          })
          .then((response) => response.status),
      ),
    );
    return responses;
  }

  it('creates exactly one appointment when many customers book the same slot', async () => {
    // One bay is the bottleneck. Technicians are plentiful so the scarce
    // resource is unambiguous and the assertion cannot pass for the wrong
    // reason.
    const scenario = await createScenario({ ...UTC_DEALERSHIP, technicianCount: 20, bayCount: 1, vehicleCount: 0 });
    const vehicleIds = await createVehicles(scenario.customerId, CONCURRENT_BOOKERS);

    const statuses = await stampede(scenario, vehicleIds);

    const created = statuses.filter((status) => status === 201).length;
    const refused = statuses.filter((status) => status === 409).length;

    expect(created).toBe(1);
    expect(refused).toBe(CONCURRENT_BOOKERS - 1);
    // No request may fail for any other reason -- a 500 here would mean the
    // race was "handled" by crashing.
    expect(created + refused).toBe(CONCURRENT_BOOKERS);

    // The database is the real assertion: whatever the API reported, there must
    // be exactly one live booking for that bay and time.
    expect(await testDb.appointment.count({ where: { status: 'CONFIRMED' } })).toBe(1);

    // One confirmation per confirmed booking, under the heaviest contention the
    // suite produces. Because the event is written by the same statement as the
    // appointment, this count cannot drift -- a mismatch either way would mean
    // the atomicity claim had quietly broken.
    expect(await testDb.outboxEvent.count()).toBe(1);
  });

  it('fills every bay exactly once when capacity is greater than one', async () => {
    // Capacity 5 against 200 bookers: the system must neither overbook (6+) nor
    // waste capacity (fewer than 5) by conceding too early in the retry loop.
    const capacity = 5;
    const scenario = await createScenario({
      ...UTC_DEALERSHIP,
      technicianCount: 20,
      bayCount: capacity,
      vehicleCount: 0,
    });
    const vehicleIds = await createVehicles(scenario.customerId, CONCURRENT_BOOKERS);

    const statuses = await stampede(scenario, vehicleIds);
    const created = statuses.filter((status) => status === 201).length;

    expect(created).toBe(capacity);
    expect(await testDb.appointment.count({ where: { status: 'CONFIRMED' } })).toBe(capacity);

    // Every winner must hold a distinct bay -- proof the constraint discriminated
    // by resource rather than merely limiting the total.
    const appointments = await testDb.appointment.findMany({ select: { serviceBayId: true } });
    expect(new Set(appointments.map((a) => a.serviceBayId)).size).toBe(capacity);

    // Every winner announced exactly once -- no lost and no duplicated events.
    expect(await testDb.outboxEvent.count()).toBe(capacity);
  });

  it('is limited by technicians when they are the scarce resource', async () => {
    const scenario = await createScenario({ ...UTC_DEALERSHIP, technicianCount: 3, bayCount: 20, vehicleCount: 0 });
    const vehicleIds = await createVehicles(scenario.customerId, CONCURRENT_BOOKERS);

    const statuses = await stampede(scenario, vehicleIds);

    expect(statuses.filter((status) => status === 201).length).toBe(3);
    const appointments = await testDb.appointment.findMany({ select: { technicianId: true } });
    expect(new Set(appointments.map((a) => a.technicianId)).size).toBe(3);
  });

  it('never double-books when holds and bookings contend for the same slot', async () => {
    // Mixed traffic: holds and outright bookings compete through different code
    // paths but the same constraints, which is where an inconsistency would hide.
    const scenario = await createScenario({ ...UTC_DEALERSHIP, technicianCount: 20, bayCount: 1, vehicleCount: 0 });
    const vehicleIds = await createVehicles(scenario.customerId, CONCURRENT_BOOKERS);
    const server = app.getHttpServer();

    const statuses = await Promise.all(
      vehicleIds.map((vehicleId, index) =>
        request(server)
          .post(index % 2 === 0 ? '/holds' : '/appointments')
          .send({
            dealershipId: scenario.dealershipId,
            customerId: scenario.customerId,
            vehicleId,
            serviceTypeId: scenario.serviceTypeId,
            startAt: CONTENDED_SLOT,
          })
          .then((response) => response.status),
      ),
    );

    expect(statuses.filter((status) => status === 201).length).toBe(1);
    expect(
      await testDb.appointment.count({ where: { status: { in: ['HELD', 'CONFIRMED'] } } }),
    ).toBe(1);
  });

  it('creates one appointment when a retried request arrives concurrently', async () => {
    // Simulates a client or load balancer retrying in flight: the same
    // idempotency key must resolve to one appointment, not a duplicate.
    const scenario = await createScenario({ ...UTC_DEALERSHIP, technicianCount: 5, bayCount: 5 });
    const server = app.getHttpServer();
    const key = 'concurrent-retry-key';

    const payload = {
      dealershipId: scenario.dealershipId,
      customerId: scenario.customerId,
      vehicleId: scenario.vehicleIds[0],
      serviceTypeId: scenario.serviceTypeId,
      startAt: CONTENDED_SLOT,
    };

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(server).post('/appointments').set('Idempotency-Key', key).send(payload),
      ),
    );

    const successful = responses.filter((response) => response.status === 201);
    expect(successful.length).toBeGreaterThan(0);

    const ids = new Set(successful.map((response) => response.body.data.id));
    expect(ids.size).toBe(1);
    expect(await testDb.appointment.count()).toBe(1);
  });
});
