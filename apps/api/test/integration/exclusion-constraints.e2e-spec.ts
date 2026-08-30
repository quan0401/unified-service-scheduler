/**
 * Proves the database -- not the application -- prevents double-booking.
 *
 * This suite runs before any service code exists and bypasses the application
 * entirely, inserting through Prisma directly. That is the point: every later
 * test in this repository trusts that an overlapping row cannot be written, and
 * a guarantee nobody verified is just a comment. If these tests fail, the
 * migration did not do what its comments claim and the rest of the design is
 * unsound.
 */
import { AppointmentStatus } from '@prisma/client';
import { testDb, resetData } from '../support/db';
import { isExclusionViolation, violatedConstraintName } from '../../src/common/postgres-errors';
import { createScenario, type Scenario } from '../support/fixtures';

/** Fixed instants keep these assertions independent of the wall clock. */
const NINE_AM = new Date('2026-09-07T09:00:00.000Z');
const TEN_AM = new Date('2026-09-07T10:00:00.000Z');
const HALF_NINE = new Date('2026-09-07T09:30:00.000Z');
const HALF_TEN = new Date('2026-09-07T10:30:00.000Z');
const ELEVEN_AM = new Date('2026-09-07T11:00:00.000Z');

interface BookingOverrides {
  technicianId?: string;
  serviceBayId?: string;
  vehicleId?: string;
  startAt?: Date;
  endAt?: Date;
  status?: AppointmentStatus;
  holdExpiresAt?: Date | null;
}

function book(scenario: Scenario, overrides: BookingOverrides = {}) {
  const status = overrides.status ?? AppointmentStatus.CONFIRMED;
  return testDb.appointment.create({
    data: {
      dealershipId: scenario.dealershipId,
      customerId: scenario.customerId,
      serviceTypeId: scenario.serviceTypeId,
      vehicleId: overrides.vehicleId ?? scenario.vehicleIds[0],
      technicianId: overrides.technicianId ?? scenario.technicianIds[0],
      serviceBayId: overrides.serviceBayId ?? scenario.bayIds[0],
      startAt: overrides.startAt ?? NINE_AM,
      endAt: overrides.endAt ?? TEN_AM,
      status,
      // The hold_expiry_only_when_held check constraint ties these together.
      holdExpiresAt:
        overrides.holdExpiresAt !== undefined
          ? overrides.holdExpiresAt
          : status === AppointmentStatus.HELD
            ? new Date(Date.now() + 120_000)
            : null,
    },
  });
}

/**
 * Asserts the write failed specifically on 23P01, and optionally that a named
 * constraint was the one that rejected it. Asserting the SQLSTATE rather than
 * "it threw" matters: a typo in the fixture would also throw, and would
 * otherwise be mistaken for the guarantee working.
 */
async function expectExclusionViolation(
  promise: Promise<unknown>,
  constraintName?: string,
): Promise<void> {
  let caught: unknown;
  let threw = false;
  try {
    await promise;
  } catch (error) {
    threw = true;
    caught = error;
  }

  // An explicit flag rather than expect.assertions(): that counter is
  // test-scoped, so it would also count assertions the caller makes afterwards.
  if (!threw) {
    throw new Error(
      'Expected the insert to be rejected by an exclusion constraint, but it succeeded.',
    );
  }

  expect(isExclusionViolation(caught)).toBe(true);
  if (constraintName) expect(violatedConstraintName(caught)).toBe(constraintName);
}

describe('appointment exclusion constraints', () => {
  let scenario: Scenario;

  beforeEach(async () => {
    await resetData();
    // Two technicians, two bays, two vehicles so each test can isolate exactly
    // one contended resource and vary the others freely.
    scenario = await createScenario({ technicianCount: 2, bayCount: 2, vehicleCount: 2 });
  });

  afterAll(async () => {
    await testDb.$disconnect();
  });

  describe('technician double-booking', () => {
    it('rejects a second appointment overlapping the same technician', async () => {
      await book(scenario);

      await expectExclusionViolation(
        book(scenario, {
          serviceBayId: scenario.bayIds[1],
          vehicleId: scenario.vehicleIds[1],
          startAt: HALF_NINE,
          endAt: HALF_TEN,
        }),
        'appointment_no_technician_overlap',
      );

      expect(await testDb.appointment.count()).toBe(1);
    });

    it('allows the same technician at a non-overlapping time', async () => {
      await book(scenario);
      await book(scenario, {
        vehicleId: scenario.vehicleIds[1],
        startAt: TEN_AM,
        endAt: ELEVEN_AM,
      });

      expect(await testDb.appointment.count()).toBe(2);
    });
  });

  describe('service bay double-booking', () => {
    it('rejects a second appointment overlapping the same bay', async () => {
      await book(scenario);

      await expectExclusionViolation(
        book(scenario, {
          technicianId: scenario.technicianIds[1],
          vehicleId: scenario.vehicleIds[1],
          startAt: HALF_NINE,
          endAt: HALF_TEN,
        }),
        'appointment_no_bay_overlap',
      );

      expect(await testDb.appointment.count()).toBe(1);
    });
  });

  describe('vehicle double-booking', () => {
    it('rejects the same vehicle being booked into two bays at once', async () => {
      await book(scenario);

      await expectExclusionViolation(
        book(scenario, {
          technicianId: scenario.technicianIds[1],
          serviceBayId: scenario.bayIds[1],
          startAt: HALF_NINE,
          endAt: HALF_TEN,
        }),
        'appointment_no_vehicle_overlap',
      );

      expect(await testDb.appointment.count()).toBe(1);
    });
  });

  describe('half-open range bounds', () => {
    // '[)' bounds are what make back-to-back scheduling possible. With '[]'
    // bounds every appointment would block the slot immediately after it.
    it('treats an appointment starting exactly when another ends as free', async () => {
      await book(scenario, { startAt: NINE_AM, endAt: TEN_AM });
      await book(scenario, {
        vehicleId: scenario.vehicleIds[1],
        startAt: TEN_AM,
        endAt: ELEVEN_AM,
      });

      expect(await testDb.appointment.count()).toBe(2);
    });

    it('rejects an overlap of even one minute', async () => {
      await book(scenario, { startAt: NINE_AM, endAt: TEN_AM });

      await expectExclusionViolation(
        book(scenario, {
          vehicleId: scenario.vehicleIds[1],
          startAt: new Date('2026-09-07T09:59:00.000Z'),
          endAt: ELEVEN_AM,
        }),
      );
    });
  });

  describe('status participation', () => {
    it('lets a HELD row block a competing booking', async () => {
      await book(scenario, { status: AppointmentStatus.HELD });

      await expectExclusionViolation(
        book(scenario, { vehicleId: scenario.vehicleIds[1], startAt: HALF_NINE, endAt: HALF_TEN }),
      );
    });

    it('frees the slot once an appointment is CANCELLED', async () => {
      const first = await book(scenario);
      await testDb.appointment.update({
        where: { id: first.id },
        data: { status: AppointmentStatus.CANCELLED, cancelledAt: new Date() },
      });

      await book(scenario, { vehicleId: scenario.vehicleIds[1] });

      expect(await testDb.appointment.count({ where: { status: 'CONFIRMED' } })).toBe(1);
    });

    it('does not let a COMPLETED row block the same slot', async () => {
      const first = await book(scenario);
      await testDb.appointment.update({
        where: { id: first.id },
        data: { status: AppointmentStatus.COMPLETED },
      });

      await expect(book(scenario, { vehicleId: scenario.vehicleIds[1] })).resolves.toBeDefined();
    });
  });

  describe('check constraints', () => {
    it('rejects an appointment that ends before it starts', async () => {
      await expect(book(scenario, { startAt: TEN_AM, endAt: NINE_AM })).rejects.toBeDefined();
    });

    it('rejects a HELD row with no expiry', async () => {
      await expect(
        book(scenario, { status: AppointmentStatus.HELD, holdExpiresAt: null }),
      ).rejects.toBeDefined();
    });

    it('rejects a CONFIRMED row carrying a hold expiry', async () => {
      await expect(
        book(scenario, {
          status: AppointmentStatus.CONFIRMED,
          holdExpiresAt: new Date(Date.now() + 60_000),
        }),
      ).rejects.toBeDefined();
    });
  });
});
