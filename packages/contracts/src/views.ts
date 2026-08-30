/** Response payloads, as the client receives them. */

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
