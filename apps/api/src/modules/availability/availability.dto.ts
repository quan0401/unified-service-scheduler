/**
 * NestJS DTO for the availability grid.
 *
 * Zod remains the single source of truth -- it produces the runtime validator,
 * the TypeScript type, and the OpenAPI schema -- but the declaration now lives
 * in @scheduler/contracts so the client shares it rather than restating it.
 *
 * The view types are re-exported so callers inside this module keep importing
 * from one place.
 */
import { createZodDto } from 'nestjs-zod';
import { availabilityQuerySchema } from '@scheduler/contracts';

export class AvailabilityQueryDto extends createZodDto(availabilityQuerySchema) {}

export type { AvailabilityView, AvailabilitySlotView } from '@scheduler/contracts';
