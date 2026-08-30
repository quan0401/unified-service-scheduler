/**
 * Response shapes the server returns but `@scheduler/contracts` does not
 * publish. Contracts exports the request schemas, AvailabilityView, the
 * envelope, and the error-code union -- not the appointment record, which
 * exists only as a Prisma inference in booking.repository.ts.
 *
 * This file is therefore the one place the client restates the server's shape
 * in its own words, which is precisely the drift contracts exists to remove.
 * It is isolated here so that publishing an AppointmentView from contracts
 * later is a deletion, not a refactor.
 */

export type AppointmentStatus = 'HELD' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED';

export interface DealershipView {
  id: string;
  name: string;
  timezone: string;
  openingHours: OpeningHourView[];
}

export interface OpeningHourView {
  /** ISO weekday, 1 = Monday through 7 = Sunday. A missing row means closed. */
  dayOfWeek: number;
  openMinute: number;
  closeMinute: number;
}

export interface ServiceTypeView {
  id: string;
  name: string;
  durationMinutes: number;
}

export interface CustomerView {
  id: string;
  name: string;
  email: string;
}

export interface VehicleView {
  id: string;
  vin: string;
  make: string;
  model: string;
  year: number;
}

export interface HealthView {
  status: string;
  uptimeSeconds: number;
}

export interface AppointmentRecord {
  id: string;
  dealershipId: string;
  customerId: string;
  vehicleId: string;
  serviceTypeId: string;
  technicianId: string;
  serviceBayId: string;
  startAt: string;
  endAt: string;
  status: AppointmentStatus;
  holdExpiresAt: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  dealership: { id: string; name: string; timezone: string };
  customer: { id: string; name: string; email: string };
  vehicle: VehicleView;
  serviceType: ServiceTypeView;
  technician: { id: string; name: string };
  serviceBay: { id: string; name: string };
}

/** POST /holds adds the TTL the server applied. */
export type HoldRecord = AppointmentRecord & { expiresInSeconds: number };

/** POST /appointments reports whether an Idempotency-Key was replayed. */
export type BookedRecord = AppointmentRecord & { replayed: boolean };
