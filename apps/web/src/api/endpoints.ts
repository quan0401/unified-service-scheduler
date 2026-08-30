import type {
  AvailabilityQuery,
  AvailabilityView,
  CreateAppointmentRequest,
  CreateHoldRequest,
} from '@scheduler/contracts';
import { request, type RequestOptions } from './client';
import type {
  AppointmentRecord,
  BookedRecord,
  CustomerView,
  DealershipView,
  HealthView,
  HoldRecord,
  ServiceTypeView,
  VehicleView,
} from './types';

/** One line per endpoint, no logic, so every call site is greppable. */
export const api = {
  health: (signal?: AbortSignal) => request<HealthView>('/health', { signal }),

  dealerships: (signal?: AbortSignal) => request<DealershipView[]>('/dealerships', { signal }),

  serviceTypes: (signal?: AbortSignal) => request<ServiceTypeView[]>('/service-types', { signal }),

  customers: (signal?: AbortSignal) => request<CustomerView[]>('/customers', { signal }),

  vehicles: (customerId: string, signal?: AbortSignal) =>
    request<VehicleView[]>(`/customers/${customerId}/vehicles`, { signal }),

  availability: (query: AvailabilityQuery, signal?: AbortSignal) =>
    request<AvailabilityView>('/availability', { query: { ...query }, signal }),

  createHold: (body: CreateHoldRequest) => request<HoldRecord>('/holds', { method: 'POST', body }),

  createAppointment: (
    body: CreateAppointmentRequest,
    options: Pick<RequestOptions, 'idempotencyKey' | 'requestId'> = {},
  ) => request<BookedRecord>('/appointments', { method: 'POST', body, ...options }),

  listAppointments: (customerId: string, signal?: AbortSignal) =>
    request<AppointmentRecord[]>('/appointments', { query: { customerId }, signal }),

  getAppointment: (id: string) => request<AppointmentRecord>(`/appointments/${id}`),

  cancelAppointment: (id: string) => request<void>(`/appointments/${id}`, { method: 'DELETE' }),
} as const;
