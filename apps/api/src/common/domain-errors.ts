/**
 * Domain errors, decoupled from HTTP.
 *
 * Services throw these; a single exception filter maps them to status codes.
 * That keeps transport concerns out of business logic and guarantees every
 * failure leaves the process through one place, so no stack trace or driver
 * message can leak into a response by accident.
 */

export type DomainErrorCode =
  | 'DEALERSHIP_NOT_FOUND'
  | 'SERVICE_TYPE_NOT_FOUND'
  | 'CUSTOMER_NOT_FOUND'
  | 'VEHICLE_NOT_FOUND'
  | 'APPOINTMENT_NOT_FOUND'
  | 'HOLD_NOT_FOUND'
  | 'HOLD_EXPIRED'
  | 'VEHICLE_NOT_OWNED'
  | 'OUTSIDE_OPENING_HOURS'
  | 'SLOT_UNAVAILABLE'
  | 'SLOT_CONTENDED'
  | 'APPOINTMENT_NOT_CANCELLABLE'
  | 'VALIDATION_FAILED';

export abstract class DomainError extends Error {
  abstract readonly code: DomainErrorCode;
  /** Extra context returned to the client; must never contain internals. */
  readonly details?: Record<string, unknown>;

  protected constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

export class NotFoundError extends DomainError {
  readonly code: DomainErrorCode;
  constructor(code: DomainErrorCode, message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.code = code;
  }
}

/**
 * The requested vehicle belongs to a different customer.
 *
 * Not strictly an authentication failure -- this service has no auth by design --
 * but it is the one ownership rule the domain requires, since an appointment
 * associates a customer *and* their vehicle.
 */
export class VehicleNotOwnedError extends DomainError {
  readonly code = 'VEHICLE_NOT_OWNED' as const;
  constructor(vehicleId: string, customerId: string) {
    super('The requested vehicle does not belong to this customer.', {
      vehicleId,
      customerId,
    });
  }
}

export class OutsideOpeningHoursError extends DomainError {
  readonly code = 'OUTSIDE_OPENING_HOURS' as const;
  constructor(details: Record<string, unknown>) {
    super('The requested time falls outside the dealership opening hours.', details);
  }
}

/**
 * No qualified technician and capable bay pair is free for the whole duration.
 * This is the ordinary "fully booked" answer, not a fault.
 */
export class SlotUnavailableError extends DomainError {
  readonly code = 'SLOT_UNAVAILABLE' as const;
  constructor(details?: Record<string, unknown>) {
    super('No technician and service bay are available for the requested time.', details);
  }
}

/**
 * Resources appeared free but every attempt lost a race to a concurrent booker.
 *
 * Distinct from SLOT_UNAVAILABLE on purpose: this one means the system is under
 * genuine contention rather than simply full, and it is the signal that drives
 * the booking_retry_exhausted metric.
 */
export class SlotContendedError extends DomainError {
  readonly code = 'SLOT_CONTENDED' as const;
  constructor(attempts: number) {
    super('The requested slot was taken by another booking. Please choose another time.', {
      attempts,
    });
  }
}

export class HoldExpiredError extends DomainError {
  readonly code = 'HOLD_EXPIRED' as const;
  constructor(holdId: string) {
    super('This reservation has expired. Please select a time again.', { holdId });
  }
}

export class AppointmentNotCancellableError extends DomainError {
  readonly code = 'APPOINTMENT_NOT_CANCELLABLE' as const;
  constructor(status: string) {
    super(`An appointment with status ${status} cannot be cancelled.`, { status });
  }
}
