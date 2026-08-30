/**
 * Request schema for the availability grid.
 *
 * Zod is the single source of truth: it produces the runtime validator, the
 * TypeScript type, and the OpenAPI schema, so those three can never drift.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const availabilityQuerySchema = z.object({
  dealershipId: z.uuid(),
  serviceTypeId: z.uuid(),
  /** Local calendar date at the dealership. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a calendar date in YYYY-MM-DD format.'),
});

export class AvailabilityQueryDto extends createZodDto(availabilityQuerySchema) {}

export interface AvailabilitySlotView {
  startAt: string;
  endAt: string;
  available: boolean;
  /** Qualified technicians free for the whole window. */
  technicianCount: number;
  /** Capable bays free for the whole window. */
  bayCount: number;
}

export interface AvailabilityView {
  dealershipId: string;
  serviceTypeId: string;
  date: string;
  timezone: string;
  durationMinutes: number;
  slots: AvailabilitySlotView[];
}
