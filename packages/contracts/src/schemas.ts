/**
 * Request schemas — the single source of truth for the API's input shape.
 *
 * These are plain Zod, deliberately. The server wraps them with `createZodDto`
 * from nestjs-zod to produce DTOs and OpenAPI metadata, but that wrapper stays
 * in the server: a browser client must not import a server framework in order
 * to validate a form.
 *
 * Keeping the schemas here rather than beside the controllers is what stops a
 * stubbed client from drifting. Validation, the TypeScript type, and the
 * published OpenAPI schema all derive from one declaration, so they cannot
 * disagree.
 */
import { z } from 'zod';

/**
 * A booking request names what the customer wants, never which technician or
 * bay to use. Resource assignment is the system's job -- letting a client pick
 * would reintroduce the check-then-act race the design exists to remove.
 */
export const createAppointmentSchema = z.object({
  dealershipId: z.uuid(),
  customerId: z.uuid(),
  vehicleId: z.uuid(),
  serviceTypeId: z.uuid(),
  /** Desired start, ISO-8601 with offset. The end is derived from the service. */
  startAt: z.iso.datetime({ offset: true }),
  /** Optional: confirms a previously placed hold instead of booking outright. */
  holdId: z.uuid().optional(),
});

/** A hold reserves the same slot a booking would, minus the promotion step. */
export const createHoldSchema = createAppointmentSchema.omit({ holdId: true });

export const listAppointmentsSchema = z.object({
  customerId: z.uuid(),
});

export const availabilityQuerySchema = z.object({
  dealershipId: z.uuid(),
  serviceTypeId: z.uuid(),
  /** Local calendar date at the dealership. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a calendar date in YYYY-MM-DD format.'),
});

export type CreateAppointmentRequest = z.infer<typeof createAppointmentSchema>;
export type CreateHoldRequest = z.infer<typeof createHoldSchema>;
export type ListAppointmentsQuery = z.infer<typeof listAppointmentsSchema>;
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;
