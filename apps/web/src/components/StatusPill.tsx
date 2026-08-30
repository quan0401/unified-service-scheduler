import type { AppointmentStatus } from '../api/types';

export function StatusPill({ status }: { status: AppointmentStatus }) {
  return <span className={`pill pill--${status.toLowerCase()}`}>{status}</span>;
}
