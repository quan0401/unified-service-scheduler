/**
 * NestJS DTOs for the booking endpoints.
 *
 * The schemas themselves live in @scheduler/contracts so a client can validate
 * against the same declaration. `createZodDto` is applied here rather than
 * there because it pulls in NestJS, which has no business in a package a
 * browser is meant to import.
 */
import { createZodDto } from 'nestjs-zod';
import {
  createAppointmentSchema,
  createHoldSchema,
  listAppointmentsSchema,
} from '@scheduler/contracts';

export class CreateAppointmentDto extends createZodDto(createAppointmentSchema) {}
export class CreateHoldDto extends createZodDto(createHoldSchema) {}
export class ListAppointmentsDto extends createZodDto(listAppointmentsSchema) {}
