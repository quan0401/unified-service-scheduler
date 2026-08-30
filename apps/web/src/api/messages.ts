import type { DomainErrorCode } from '@scheduler/contracts';
import type { ApiError } from './ApiError';

export interface ErrorCopy {
  title: string;
  body: string;
  /** Null where there is nothing useful for the user to do. */
  recovery: string | null;
}

/**
 * A mapped type over the union, so adding a code to @scheduler/contracts turns
 * into a compile error here rather than an untranslated code on screen. That is
 * the whole reason the union is exported.
 */
const DOMAIN_COPY: Record<DomainErrorCode, ErrorCopy> = {
  DEALERSHIP_NOT_FOUND: {
    title: 'Dealership not found',
    body: 'That dealership no longer exists. Reload to refresh the list.',
    recovery: 'Reload',
  },
  SERVICE_TYPE_NOT_FOUND: {
    title: 'Service not found',
    body: 'That service type no longer exists. Reload to refresh the list.',
    recovery: 'Reload',
  },
  CUSTOMER_NOT_FOUND: {
    title: 'No such customer',
    body: 'No customer exists with that id. Run `pnpm db:seed` and copy an id from the output.',
    recovery: null,
  },
  VEHICLE_NOT_FOUND: {
    title: 'No such vehicle',
    body: 'That vehicle no longer exists.',
    recovery: null,
  },
  VEHICLE_NOT_OWNED: {
    title: 'Wrong owner',
    body: 'That vehicle belongs to a different customer. An appointment must pair a customer with their own vehicle.',
    recovery: null,
  },
  APPOINTMENT_NOT_FOUND: {
    title: 'Appointment not found',
    body: 'No appointment exists with that id.',
    recovery: null,
  },
  APPOINTMENT_NOT_CANCELLABLE: {
    title: 'Already closed',
    body: 'This appointment is already cancelled or completed, so it cannot be cancelled again.',
    recovery: null,
  },
  HOLD_NOT_FOUND: {
    title: 'Hold not found',
    body: 'That reservation no longer exists.',
    recovery: 'Start over',
  },
  HOLD_NOT_OWNED: {
    title: 'Not your reservation',
    body: 'That hold belongs to a different customer. The API keeps this distinct from VEHICLE_NOT_OWNED so the message points at the right thing.',
    recovery: 'Start over',
  },
  HOLD_EXPIRED: {
    title: 'Your hold expired',
    body: 'The reservation lapsed before it was confirmed, so the slot went back on sale.',
    recovery: 'Choose another time',
  },
  OUTSIDE_OPENING_HOURS: {
    title: 'Outside opening hours',
    body: 'The dealership is closed for part of that service window. If you reached this from the slot grid, the client and server disagree about the timezone.',
    recovery: 'Refresh availability',
  },
  SLOT_UNAVAILABLE: {
    title: 'That time has just been taken',
    body: 'Availability is advisory -- it was free when the grid loaded and is not any more. Retrying will not help; pick another slot.',
    recovery: 'Refresh availability',
  },
  SLOT_CONTENDED: {
    title: 'Too much contention',
    body: 'Several bookings hit this exact slot at once and the server ran out of retries. This one is worth trying again.',
    recovery: 'Try again',
  },
  VALIDATION_FAILED: {
    title: 'Invalid request',
    body: 'The server rejected the request shape.',
    recovery: null,
  },
};

const TRANSPORT_COPY: Record<string, ErrorCopy> = {
  BAD_REQUEST: {
    title: 'Invalid input',
    body: 'The server could not parse that. Check the highlighted field.',
    recovery: null,
  },
  TOO_MANY_REQUESTS: {
    title: 'Rate limited',
    body: 'The API throttles to 20 requests/second per IP. This is the rate limiter, not a booking conflict.',
    recovery: 'Try again',
  },
  INTERNAL_ERROR: {
    title: 'Server error',
    body: 'The API failed unexpectedly. The request id below will appear in its logs.',
    recovery: 'Try again',
  },
  NETWORK_ERROR: {
    title: 'Cannot reach the API',
    body: 'The request never arrived. Check that the API is running and the proxy target is right.',
    recovery: 'Try again',
  },
  NON_JSON_RESPONSE: {
    title: 'Unexpected response',
    body: 'Something answered, but not with the API envelope. A proxy or gateway is probably in the way.',
    recovery: 'Try again',
  },
};

export function copyFor(error: ApiError): ErrorCopy {
  const domain = DOMAIN_COPY[error.code as DomainErrorCode];
  if (domain) return domain;

  const transport = TRANSPORT_COPY[error.code];
  if (transport) return transport;

  return {
    title: 'Request failed',
    body: error.message || 'The API rejected the request.',
    recovery: null,
  };
}
