/**
 * The atomic booking statement -- the heart of this service.
 *
 * Requirement 2 of the brief ("check availability before confirming") is a
 * check-then-act race. Two requests can both observe a free bay and both
 * insert. Reading first and writing second cannot close that window at any
 * isolation level short of serialising the whole table, so selection and
 * insertion happen in ONE statement: the same query that finds a free
 * technician and bay is the query that claims them.
 *
 * Correctness does not rest on this statement, though. It rests on the GiST
 * exclusion constraints in
 * `prisma/migrations/*_booking_exclusion_constraints/migration.sql`, which make
 * an overlapping row impossible to write. This statement's job is to lose that
 * race *rarely*, and to lose it cleanly (SQLSTATE 23P01) when it does.
 *
 * Rejected alternative: `SELECT ... FOR UPDATE` on the technician and bay rows.
 * A row lock locks the resource, not the time slot, so a 09:00 booking would
 * block an unrelated 15:00 booking for the same technician. At a busy
 * dealership that collapses into a hot-row queue -- correct, but serialised.
 * Exclusion constraints conflict only on (resource, overlapping range), which
 * is the finest granularity available, so unrelated bookings never interact.
 */
import { Injectable } from '@nestjs/common';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * `to_char` pattern matching JavaScript's `Date.toISOString()` byte for byte.
 *
 * Shared by both outbox writers so the two paths cannot drift into emitting
 * different timestamp formats for the same kind of event.
 */
const ISO_8601_UTC = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

export interface BookingAttempt {
  dealershipId: string;
  customerId: string;
  vehicleId: string;
  serviceTypeId: string;
  startAt: Date;
  endAt: Date;
  /** Local weekday and minute-of-day, computed once in Luxon. */
  dayOfWeek: number;
  startMinute: number;
  durationMinutes: number;
  status: AppointmentStatus;
  holdExpiresAt: Date | null;
  idempotencyKey: string | null;
}

export interface BookedRow {
  id: string;
  technician_id: string;
  service_bay_id: string;
  start_at: Date;
  end_at: Date;
  status: AppointmentStatus;
  hold_expires_at: Date | null;
}

@Injectable()
export class BookingRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Attempts to claim a technician and bay for the requested window.
   *
   * Returns the created row, or `null` when no qualified technician and capable
   * bay were free -- an ordinary "fully booked" answer, not an error. Throws
   * with SQLSTATE 23P01 when the row was rejected by an exclusion constraint,
   * meaning a concurrent booker won the race.
   */
  async attempt(attempt: BookingAttempt): Promise<BookedRow | null> {
    const rows = await this.prisma.$queryRaw<BookedRow[]>`
      WITH free_technician AS (
        SELECT t.id
        FROM technician t
        WHERE t.dealership_id = ${attempt.dealershipId}::uuid
          AND t.active
          -- Qualified: the skill row exists for this service type.
          AND EXISTS (
            SELECT 1 FROM technician_skill ts
            WHERE ts.technician_id = t.id
              AND ts.service_type_id = ${attempt.serviceTypeId}::uuid
          )
          -- On shift for the WHOLE service, not merely at its start.
          AND EXISTS (
            SELECT 1 FROM technician_shift sh
            WHERE sh.technician_id = t.id
              AND sh.day_of_week   = ${attempt.dayOfWeek}
              AND sh.start_minute <= ${attempt.startMinute}
              AND sh.end_minute   >= ${attempt.startMinute + attempt.durationMinutes}
          )
          -- Not already committed to an overlapping appointment. A lapsed hold
          -- counts as free without waiting for the sweeper to remove it.
          AND NOT EXISTS (
            SELECT 1 FROM appointment a
            WHERE a.technician_id = t.id
              AND a.status IN ('HELD', 'CONFIRMED')
              AND (a.status = 'CONFIRMED' OR a.hold_expires_at > now())
              AND tstzrange(a.start_at, a.end_at, '[)')
               && tstzrange(${attempt.startAt}, ${attempt.endAt}, '[)')
          )
        -- Deliberately random, not least-loaded. Ordering by load makes every
        -- concurrent request target the SAME technician, so N-1 of them collide
        -- and retry. Spreading picks across the free pool drops the conflict
        -- rate from roughly O(N) to near zero. This looks like a mistake and is
        -- not one.
        ORDER BY random()
        LIMIT 1
      ),
      free_bay AS (
        SELECT b.id
        FROM service_bay b
        WHERE b.dealership_id = ${attempt.dealershipId}::uuid
          AND b.active
          AND EXISTS (
            SELECT 1 FROM bay_capability bc
            WHERE bc.service_bay_id = b.id
              AND bc.service_type_id = ${attempt.serviceTypeId}::uuid
          )
          AND NOT EXISTS (
            SELECT 1 FROM appointment a
            WHERE a.service_bay_id = b.id
              AND a.status IN ('HELD', 'CONFIRMED')
              AND (a.status = 'CONFIRMED' OR a.hold_expires_at > now())
              AND tstzrange(a.start_at, a.end_at, '[)')
               && tstzrange(${attempt.startAt}, ${attempt.endAt}, '[)')
          )
        ORDER BY random()
        LIMIT 1
      ),
      booked AS (
        INSERT INTO appointment (
          id, dealership_id, customer_id, vehicle_id, service_type_id,
          technician_id, service_bay_id, start_at, end_at, status,
          hold_expires_at, idempotency_key, created_at, updated_at
        )
        -- The cross join yields exactly one row when both CTEs found a resource,
        -- and zero rows when either did not -- so "nothing available" needs no
        -- separate query and carries no extra round trip.
        SELECT
          gen_random_uuid(),
          ${attempt.dealershipId}::uuid,
          ${attempt.customerId}::uuid,
          ${attempt.vehicleId}::uuid,
          ${attempt.serviceTypeId}::uuid,
          ft.id,
          fb.id,
          ${attempt.startAt},
          ${attempt.endAt},
          ${attempt.status}::"AppointmentStatus",
          ${attempt.holdExpiresAt},
          ${attempt.idempotencyKey},
          now(),
          now()
        FROM free_technician ft, free_bay fb
        RETURNING
          id, customer_id, vehicle_id, technician_id, service_bay_id,
          start_at, end_at, status, hold_expires_at
      ),
      -- The transactional outbox, written in the SAME STATEMENT as the
      -- appointment -- which is what makes the claim true rather than merely
      -- intended. A single statement is a single transaction, so the event and
      -- the appointment commit together or not at all. A confirmation can never
      -- be emitted for a booking that rolled back, and a booking can never
      -- commit without its event.
      --
      -- Three things make this work, all documented behaviour of data-modifying
      -- CTEs (PostgreSQL 16, §7.8.4):
      --   1. Sub-statements share one snapshot and cannot see each other's
      --      effects; RETURNING is the only sanctioned channel between them.
      --      Reading "booked" below is therefore also what ORDERS the two
      --      inserts -- without that data dependency their order is undefined.
      --   2. A data-modifying CTE runs "exactly once, and always to completion,
      --      independently of whether the primary query reads ... any of their
      --      output". Nothing references "event", and it still executes.
      --   3. Zero rows from "booked" yields zero rows here, so a failed claim
      --      emits nothing without needing a conditional.
      --
      -- Rejected alternative: a second round trip inside an interactive
      -- transaction. Correct, but it holds the appointment's exclusion-constraint
      -- locks across a network hop, and a competing booker waits exactly as long
      -- as those locks are held. See myDocs/outbox-atomicity-cte-vs-transaction.md.
      event AS (
        INSERT INTO outbox_event (id, event_type, aggregate_id, payload)
        SELECT
          gen_random_uuid(),
          'appointment.confirmed',
          b.id,
          jsonb_build_object(
            'appointmentId', b.id,
            'customerId',    b.customer_id,
            'vehicleId',     b.vehicle_id,
            'technicianId',  b.technician_id,
            'serviceBayId',  b.service_bay_id,
            -- Reproduces Date.toISOString() exactly, so the payload wire format
            -- is unchanged by the move from application code into SQL.
            'startAt', to_char(b.start_at AT TIME ZONE 'UTC', ${ISO_8601_UTC}),
            'endAt',   to_char(b.end_at   AT TIME ZONE 'UTC', ${ISO_8601_UTC})
          )
        FROM booked b
        -- A hold is not a booking. Only a confirmation is announced, matching
        -- the previous behaviour where the hold path never wrote an event.
        WHERE b.status = 'CONFIRMED'
      )
      SELECT
        id, technician_id, service_bay_id, start_at, end_at, status, hold_expires_at
      FROM booked
    `;

    return rows[0] ?? null;
  }

  /**
   * Physically removes lapsed holds overlapping a window.
   *
   * Necessary because of an asymmetry that is easy to miss: the booking query
   * treats a hold as free once `hold_expires_at` has passed, but the exclusion
   * constraint cannot. An exclusion predicate must be IMMUTABLE, so it cannot
   * call `now()` -- its predicate is `status IN ('HELD','CONFIRMED')` and
   * nothing more. An expired hold therefore still occupies the slot at the
   * constraint level while appearing free to every query.
   *
   * The result is a slot that looks bookable and rejects every booking, until
   * the background sweeper happens to run. Reclaiming the overlapping range
   * directly makes the booking path self-healing rather than dependent on a
   * job's schedule.
   *
   * Called only after a conflict, so the common path stays a single statement.
   */
  async reclaimExpiredHolds(startAt: Date, endAt: Date): Promise<number> {
    return this.prisma.$executeRaw`
      DELETE FROM appointment
      WHERE status = 'HELD'
        AND hold_expires_at <= now()
        AND tstzrange(start_at, end_at, '[)') && tstzrange(${startAt}, ${endAt}, '[)')
    `;
  }

  /**
   * Promotes a live hold to a confirmed appointment.
   *
   * Conditioned on the row still being HELD and unexpired, so a hold that
   * lapsed between selection and submission cannot be silently revived. The
   * status change moves the row out of hold accounting while keeping it inside
   * the exclusion constraints, so the slot never becomes momentarily bookable.
   */
  async confirmHold(holdId: string): Promise<BookedRow | null> {
    const rows = await this.prisma.$queryRaw<BookedRow[]>`
      WITH confirmed AS (
        UPDATE appointment
        SET status = 'CONFIRMED', hold_expires_at = NULL, updated_at = now()
        WHERE id = ${holdId}::uuid
          AND status = 'HELD'
          AND hold_expires_at > now()
        RETURNING
          id, customer_id, vehicle_id, technician_id, service_bay_id,
          start_at, end_at, status, hold_expires_at
      ),
      -- Same statement, same reasoning as attempt(): promoting the hold and
      -- announcing the confirmation commit together. A hold that failed to
      -- promote (expired, or already gone) returns zero rows, so no event is
      -- written -- no conditional required.
      event AS (
        INSERT INTO outbox_event (id, event_type, aggregate_id, payload)
        SELECT
          gen_random_uuid(),
          'appointment.confirmed',
          c.id,
          jsonb_build_object(
            'appointmentId', c.id,
            'customerId',    c.customer_id,
            'vehicleId',     c.vehicle_id,
            'technicianId',  c.technician_id,
            'serviceBayId',  c.service_bay_id,
            'startAt', to_char(c.start_at AT TIME ZONE 'UTC', ${ISO_8601_UTC}),
            'endAt',   to_char(c.end_at   AT TIME ZONE 'UTC', ${ISO_8601_UTC})
          )
        FROM confirmed c
      )
      SELECT
        id, technician_id, service_bay_id, start_at, end_at, status, hold_expires_at
      FROM confirmed
    `;

    return rows[0] ?? null;
  }

  /** Full appointment with the associations the brief requires on a confirmation. */
  findById(id: string) {
    return this.prisma.appointment.findUnique({
      where: { id },
      include: APPOINTMENT_DETAIL,
    });
  }

  findByIdempotencyKey(key: string) {
    return this.prisma.appointment.findUnique({
      where: { idempotencyKey: key },
      include: APPOINTMENT_DETAIL,
    });
  }
}

/**
 * Requirement 3: a confirmation record associating customer, vehicle,
 * technician, and bay. Shared so every read of an appointment returns the same
 * shape.
 */
export const APPOINTMENT_DETAIL = {
  dealership: { select: { id: true, name: true, timezone: true } },
  customer: { select: { id: true, name: true, email: true } },
  vehicle: { select: { id: true, vin: true, make: true, model: true, year: true } },
  serviceType: { select: { id: true, name: true, durationMinutes: true } },
  technician: { select: { id: true, name: true } },
  serviceBay: { select: { id: true, name: true } },
} satisfies Prisma.AppointmentInclude;
