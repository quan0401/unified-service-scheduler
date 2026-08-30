/**
 * Error codes a client can branch on.
 *
 * Published as part of the contract because the code, not the message, is the
 * stable thing: messages are for humans and may be reworded or localised, while
 * a client switching on SLOT_UNAVAILABLE versus SLOT_CONTENDED is making a real
 * distinction -- fully booked, versus lost a race and worth retrying.
 */
export type DomainErrorCode =
  | 'DEALERSHIP_NOT_FOUND'
  | 'SERVICE_TYPE_NOT_FOUND'
  | 'CUSTOMER_NOT_FOUND'
  | 'VEHICLE_NOT_FOUND'
  | 'APPOINTMENT_NOT_FOUND'
  | 'HOLD_NOT_FOUND'
  | 'HOLD_EXPIRED'
  | 'HOLD_NOT_OWNED'
  | 'VEHICLE_NOT_OWNED'
  | 'OUTSIDE_OPENING_HOURS'
  | 'SLOT_UNAVAILABLE'
  | 'SLOT_CONTENDED'
  | 'APPOINTMENT_NOT_CANCELLABLE'
  | 'VALIDATION_FAILED';
