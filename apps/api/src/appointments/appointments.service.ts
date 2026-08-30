/**
 * Booking orchestration: validate, attempt, retry, report.
 *
 * The service deliberately holds no locks and opens no long transactions. All
 * mutual exclusion lives in the database (see `BookingRepository`), so this
 * layer stays concerned with domain rules -- ownership, opening hours, hold
 * lifecycle -- and with how to respond when a race is lost.
 */
import { Injectable, Logger } from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BookingRepository, APPOINTMENT_DETAIL, type BookedRow } from './booking.repository';
import { isExclusionViolation, isUniqueViolation } from '../common/postgres-errors';
import {
  HoldExpiredError,
  NotFoundError,
  OutsideOpeningHoursError,
  SlotContendedError,
  SlotUnavailableError,
  VehicleNotOwnedError,
  AppointmentNotCancellableError,
} from '../common/domain-errors';
import { isWithinOpeningHours, localFieldsAt } from '../availability/slot-generator';
import { MetricsService } from '../observability/metrics.service';

/**
 * How many times a booking may lose a race before reporting contention.
 *
 * Bounded on purpose. Unbounded retry under a stampede converts a contended
 * slot into sustained database load; three attempts is enough to absorb
 * incidental collisions while guaranteeing the request terminates promptly.
 */
const MAX_BOOKING_ATTEMPTS = 3;

/** Jittered backoff. Uniform delays would re-synchronise the racers we just separated. */
const RETRY_BASE_DELAY_MS = 15;

export interface BookingRequest {
  dealershipId: string;
  customerId: string;
  vehicleId: string;
  serviceTypeId: string;
  startAt: Date;
  holdId?: string;
  idempotencyKey?: string;
}

export interface BookingOutcome {
  appointment: NonNullable<Awaited<ReturnType<BookingRepository['findById']>>>;
  /** True when an existing appointment was replayed rather than created. */
  replayed: boolean;
  attempts: number;
}

@Injectable()
export class AppointmentsService {
  private readonly logger = new Logger(AppointmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingRepository,
    private readonly metrics: MetricsService,
  ) {}

  async book(request: BookingRequest): Promise<BookingOutcome> {
    const startedAt = Date.now();
    try {
      const outcome = await this.attemptBooking(request);
      this.metrics.recordBooking(
        outcome.replayed ? 'replayed' : 'confirmed',
        outcome.attempts,
        (Date.now() - startedAt) / 1000,
      );
      return outcome;
    } catch (error) {
      const contended = error instanceof SlotContendedError;
      const outcome = contended
        ? 'contended'
        : error instanceof SlotUnavailableError
          ? 'unavailable'
          : 'rejected';

      if (contended) this.metrics.recordRetriesExhausted();

      // A contended request made every attempt allowed before giving up.
      // Recording zero would understate exactly the requests that pushed the
      // retry budget hardest, which is the population worth watching.
      this.metrics.recordBooking(
        outcome,
        contended ? attemptsOf(error) : 0,
        (Date.now() - startedAt) / 1000,
      );
      throw error;
    }
  }

  private async attemptBooking(request: BookingRequest): Promise<BookingOutcome> {
    // Replay before any work: a retried request must not create a second
    // appointment, and answering from the stored row is also the cheapest path.
    if (request.idempotencyKey) {
      const existing = await this.bookings.findByIdempotencyKey(request.idempotencyKey);
      if (existing) return { appointment: existing, replayed: true, attempts: 0 };
    }

    if (request.holdId) return this.confirmHold(request);

    const context = await this.loadAndValidate(request);
    const endAt = new Date(request.startAt.getTime() + context.durationMinutes * 60_000);
    const local = localFieldsAt(request.startAt, context.timezone);

    let attempts = 0;
    while (attempts < MAX_BOOKING_ATTEMPTS) {
      attempts++;
      try {
        const row = await this.bookings.attempt({
          dealershipId: request.dealershipId,
          customerId: request.customerId,
          vehicleId: request.vehicleId,
          serviceTypeId: request.serviceTypeId,
          startAt: request.startAt,
          endAt,
          dayOfWeek: local.dayOfWeek,
          startMinute: local.startMinute,
          durationMinutes: context.durationMinutes,
          status: AppointmentStatus.CONFIRMED,
          holdExpiresAt: null,
          idempotencyKey: request.idempotencyKey ?? null,
        });

        // Zero rows means no qualified technician or capable bay was free.
        // That is a settled answer, not a race, so retrying cannot help.
        if (!row) throw new SlotUnavailableError({ startAt: request.startAt.toISOString() });

        await this.recordBooked(row, request);
        return { appointment: await this.requireById(row.id), replayed: false, attempts };
      } catch (error) {
        // Two requests raced with the same idempotency key: the loser reads the
        // winner's row rather than reporting a conflict the client cannot act on.
        if (isUniqueViolation(error) && request.idempotencyKey) {
          const winner = await this.bookings.findByIdempotencyKey(request.idempotencyKey);
          if (winner) return { appointment: winner, replayed: true, attempts };
        }

        if (!isExclusionViolation(error)) throw error;

        // Lost the race. The resource we picked was claimed between our read
        // and our insert; another may still be free, so try again.
        this.metrics.recordConflict();
        this.logger.debug(
          `Booking attempt ${attempts}/${MAX_BOOKING_ATTEMPTS} lost a race for ` +
            `${request.startAt.toISOString()} at dealership ${request.dealershipId}`,
        );
        if (attempts >= MAX_BOOKING_ATTEMPTS) break;
        // A conflict can mean a genuine competitor or a lapsed hold still
        // physically holding the slot. Clearing the latter costs one indexed
        // delete and makes the retry meaningful instead of doomed.
        await this.bookings.reclaimExpiredHolds(request.startAt, endAt);
        await jitteredBackoff(attempts);
      }
    }

    throw new SlotContendedError(attempts);
  }

  /** Places a short-lived reservation so a customer can complete a booking form. */
  async hold(request: BookingRequest, holdTtlSeconds: number): Promise<BookingOutcome> {
    const context = await this.loadAndValidate(request);
    const endAt = new Date(request.startAt.getTime() + context.durationMinutes * 60_000);
    const local = localFieldsAt(request.startAt, context.timezone);

    let attempts = 0;
    while (attempts < MAX_BOOKING_ATTEMPTS) {
      attempts++;
      try {
        const row = await this.bookings.attempt({
          dealershipId: request.dealershipId,
          customerId: request.customerId,
          vehicleId: request.vehicleId,
          serviceTypeId: request.serviceTypeId,
          startAt: request.startAt,
          endAt,
          dayOfWeek: local.dayOfWeek,
          startMinute: local.startMinute,
          durationMinutes: context.durationMinutes,
          status: AppointmentStatus.HELD,
          holdExpiresAt: new Date(Date.now() + holdTtlSeconds * 1000),
          idempotencyKey: null,
        });

        if (!row) throw new SlotUnavailableError({ startAt: request.startAt.toISOString() });
        return { appointment: await this.requireById(row.id), replayed: false, attempts };
      } catch (error) {
        if (!isExclusionViolation(error)) throw error;
        this.metrics.recordConflict();
        if (attempts >= MAX_BOOKING_ATTEMPTS) break;
        await this.bookings.reclaimExpiredHolds(request.startAt, endAt);
        await jitteredBackoff(attempts);
      }
    }

    this.metrics.recordRetriesExhausted();
    throw new SlotContendedError(attempts);
  }

  /**
   * Turns a live hold into a confirmed appointment.
   *
   * No availability re-check is needed: the hold has occupied the slot inside
   * the exclusion constraints since it was placed, so nothing could have taken
   * it. Only expiry can have intervened.
   */
  private async confirmHold(request: BookingRequest): Promise<BookingOutcome> {
    const holdId = request.holdId as string;
    const hold = await this.bookings.findById(holdId);
    if (!hold) throw new NotFoundError('HOLD_NOT_FOUND', `No reservation with id ${holdId}.`);
    if (hold.customerId !== request.customerId) {
      throw new VehicleNotOwnedError(hold.vehicleId, request.customerId);
    }
    if (hold.status === AppointmentStatus.CONFIRMED) {
      return { appointment: hold, replayed: true, attempts: 0 };
    }

    const confirmed = await this.bookings.confirmHold(holdId);
    if (!confirmed) throw new HoldExpiredError(holdId);

    if (request.idempotencyKey) {
      await this.prisma.appointment.update({
        where: { id: holdId },
        data: { idempotencyKey: request.idempotencyKey },
      });
    }

    await this.recordBooked(confirmed, request);
    return { appointment: await this.requireById(holdId), replayed: false, attempts: 1 };
  }

  async cancel(appointmentId: string): Promise<void> {
    const appointment = await this.prisma.appointment.findUnique({ where: { id: appointmentId } });
    if (!appointment) {
      throw new NotFoundError('APPOINTMENT_NOT_FOUND', `No appointment with id ${appointmentId}.`);
    }
    if (
      appointment.status === AppointmentStatus.CANCELLED ||
      appointment.status === AppointmentStatus.COMPLETED
    ) {
      throw new AppointmentNotCancellableError(appointment.status);
    }

    // Status change alone frees the slot: the exclusion constraints only apply
    // to HELD and CONFIRMED rows, so the record survives for audit while the
    // time becomes bookable again.
    await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        status: AppointmentStatus.CANCELLED,
        cancelledAt: new Date(),
        holdExpiresAt: null,
      },
    });
  }

  findById(id: string) {
    return this.requireById(id);
  }

  listForCustomer(customerId: string) {
    return this.prisma.appointment.findMany({
      where: { customerId },
      include: APPOINTMENT_DETAIL,
      orderBy: { startAt: 'desc' },
    });
  }

  /**
   * Domain preconditions that do not depend on contention.
   *
   * Checked before attempting to book so a malformed request fails immediately
   * with a precise reason, rather than presenting as "nothing available".
   */
  private async loadAndValidate(request: BookingRequest) {
    const [dealership, serviceType, vehicle] = await Promise.all([
      this.prisma.dealership.findUnique({
        where: { id: request.dealershipId },
        include: { openingHours: true },
      }),
      this.prisma.serviceType.findUnique({ where: { id: request.serviceTypeId } }),
      this.prisma.vehicle.findUnique({ where: { id: request.vehicleId } }),
    ]);

    if (!dealership) {
      throw new NotFoundError('DEALERSHIP_NOT_FOUND', `No dealership with id ${request.dealershipId}.`);
    }
    if (!serviceType) {
      throw new NotFoundError('SERVICE_TYPE_NOT_FOUND', `No service type with id ${request.serviceTypeId}.`);
    }
    if (!vehicle) {
      throw new NotFoundError('VEHICLE_NOT_FOUND', `No vehicle with id ${request.vehicleId}.`);
    }

    // The one ownership rule the domain requires: an appointment associates a
    // customer AND their vehicle, so booking someone else's car is incoherent.
    if (vehicle.customerId !== request.customerId) {
      throw new VehicleNotOwnedError(request.vehicleId, request.customerId);
    }

    if (
      !isWithinOpeningHours(
        request.startAt,
        serviceType.durationMinutes,
        dealership.timezone,
        dealership.openingHours,
      )
    ) {
      throw new OutsideOpeningHoursError({
        startAt: request.startAt.toISOString(),
        timezone: dealership.timezone,
        durationMinutes: serviceType.durationMinutes,
      });
    }

    return { timezone: dealership.timezone, durationMinutes: serviceType.durationMinutes };
  }

  private async requireById(id: string) {
    const appointment = await this.bookings.findById(id);
    if (!appointment) {
      throw new NotFoundError('APPOINTMENT_NOT_FOUND', `No appointment with id ${id}.`);
    }
    return appointment;
  }

  /**
   * Emits the confirmation event through the outbox.
   *
   * Written as a plain row rather than dispatched inline so no network call
   * happens on the booking path -- keeping transactions short is what keeps the
   * conflict window small.
   */
  private async recordBooked(row: BookedRow, request: BookingRequest): Promise<void> {
    await this.prisma.outboxEvent.create({
      data: {
        eventType: 'appointment.confirmed',
        aggregateId: row.id,
        payload: {
          appointmentId: row.id,
          customerId: request.customerId,
          vehicleId: request.vehicleId,
          technicianId: row.technician_id,
          serviceBayId: row.service_bay_id,
          startAt: row.start_at.toISOString(),
          endAt: row.end_at.toISOString(),
        },
      },
    });
  }
}

/** Recovers the attempt count a SlotContendedError recorded in its details. */
function attemptsOf(error: unknown): number {
  const attempts = (error as SlotContendedError).details?.attempts;
  return typeof attempts === 'number' ? attempts : 0;
}

function jitteredBackoff(attempt: number): Promise<void> {
  const ceiling = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  return new Promise((resolve) => setTimeout(resolve, Math.random() * ceiling));
}
