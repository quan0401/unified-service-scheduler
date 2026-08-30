import { createZodDto } from 'nestjs-zod';
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

export class CreateAppointmentDto extends createZodDto(createAppointmentSchema) {}

export const createHoldSchema = createAppointmentSchema.omit({ holdId: true });
export class CreateHoldDto extends createZodDto(createHoldSchema) {}

export const listAppointmentsSchema = z.object({
  customerId: z.uuid(),
});
export class ListAppointmentsDto extends createZodDto(listAppointmentsSchema) {}
