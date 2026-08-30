/**
 * Availability = which slots could exist (pure, from opening hours) crossed
 * with which resources are free (one database query for the whole grid).
 *
 * The two halves stay separate deliberately. Slot shape depends only on the
 * dealership calendar, so it is cheap, deterministic, and cacheable; occupancy
 * is the only part that must touch the database.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError } from '../common/domain-errors';
import { generateSlots, type Slot } from './slot-generator';
import type { AvailabilityView, AvailabilitySlotView } from './availability.dto';

/**
 * Slot spacing. Finer granularity offers customers more start times at the cost
 * of a larger grid; 15 minutes matches how service departments actually book.
 */
export const SLOT_GRANULARITY_MINUTES = 15;

interface SlotOccupancyRow {
  start_at: Date;
  end_at: Date;
  technician_count: number;
  bay_count: number;
}

@Injectable()
export class AvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  async getAvailability(
    dealershipId: string,
    serviceTypeId: string,
    date: string,
  ): Promise<AvailabilityView> {
    const [dealership, serviceType] = await Promise.all([
      this.prisma.dealership.findUnique({
        where: { id: dealershipId },
        include: { openingHours: true },
      }),
      this.prisma.serviceType.findUnique({ where: { id: serviceTypeId } }),
    ]);

    if (!dealership) {
      throw new NotFoundError('DEALERSHIP_NOT_FOUND', `No dealership with id ${dealershipId}.`);
    }
    if (!serviceType) {
      throw new NotFoundError('SERVICE_TYPE_NOT_FOUND', `No service type with id ${serviceTypeId}.`);
    }

    const slots = generateSlots({
      date,
      timezone: dealership.timezone,
      openingHours: dealership.openingHours,
      durationMinutes: serviceType.durationMinutes,
      granularityMinutes: SLOT_GRANULARITY_MINUTES,
    });

    const occupancy = slots.length
      ? await this.countFreeResources(
          slots,
          dealership.id,
          serviceType.id,
          serviceType.durationMinutes,
        )
      : [];

    return {
      dealershipId: dealership.id,
      serviceTypeId: serviceType.id,
      date,
      timezone: dealership.timezone,
      durationMinutes: serviceType.durationMinutes,
      slots: occupancy.map(toSlotView),
    };
  }

  /**
   * Counts free qualified technicians and capable bays for every slot in a
   * single round trip.
   *
   * The slot list is passed as two arrays and unnested server-side rather than
   * looped over in application code -- a day at 15-minute granularity is ~40
   * slots, and querying per slot would be 80 round trips for one page load.
   *
   * A lapsed HELD row is treated as free without waiting for the sweeper to
   * delete it, so availability is never wrong merely because a background job
   * is behind.
   */
  private countFreeResources(
    slots: Slot[],
    dealershipId: string,
    serviceTypeId: string,
    durationMinutes: number,
  ): Promise<SlotOccupancyRow[]> {
    const startAts = slots.map((slot) => slot.startAt);
    const endAts = slots.map((slot) => slot.endAt);
    // Local weekday and minutes come from the generator rather than being
    // recomputed with AT TIME ZONE here, so timezone reasoning lives in exactly
    // one place and booking cannot disagree with availability about it.
    const dows = slots.map((slot) => slot.dayOfWeek);
    const startMinutes = slots.map((slot) => slot.startMinute);

    return this.prisma.$queryRaw<SlotOccupancyRow[]>`
      WITH localised AS (
        SELECT s.start_at, s.end_at, s.dow, s.start_minute
        FROM unnest(
               ${startAts}::timestamptz[],
               ${endAts}::timestamptz[],
               ${dows}::int[],
               ${startMinutes}::int[]
             ) AS s(start_at, end_at, dow, start_minute)
      )
      SELECT
        l.start_at,
        l.end_at,
        (
          SELECT count(*) FROM technician t
          WHERE t.dealership_id = ${dealershipId}::uuid
            AND t.active
            AND EXISTS (
              SELECT 1 FROM technician_skill ts
              WHERE ts.technician_id = t.id
                AND ts.service_type_id = ${serviceTypeId}::uuid
            )
            AND EXISTS (
              SELECT 1 FROM technician_shift sh
              WHERE sh.technician_id = t.id
                AND sh.day_of_week = l.dow
                AND sh.start_minute <= l.start_minute
                AND sh.end_minute   >= l.start_minute + ${durationMinutes}
            )
            AND NOT EXISTS (
              SELECT 1 FROM appointment a
              WHERE a.technician_id = t.id
                AND a.status IN ('HELD', 'CONFIRMED')
                AND (a.status = 'CONFIRMED' OR a.hold_expires_at > now())
                AND tstzrange(a.start_at, a.end_at, '[)')
                 && tstzrange(l.start_at, l.end_at, '[)')
            )
        )::int AS technician_count,
        (
          SELECT count(*) FROM service_bay b
          WHERE b.dealership_id = ${dealershipId}::uuid
            AND b.active
            AND EXISTS (
              SELECT 1 FROM bay_capability bc
              WHERE bc.service_bay_id = b.id
                AND bc.service_type_id = ${serviceTypeId}::uuid
            )
            AND NOT EXISTS (
              SELECT 1 FROM appointment a
              WHERE a.service_bay_id = b.id
                AND a.status IN ('HELD', 'CONFIRMED')
                AND (a.status = 'CONFIRMED' OR a.hold_expires_at > now())
                AND tstzrange(a.start_at, a.end_at, '[)')
                 && tstzrange(l.start_at, l.end_at, '[)')
            )
        )::int AS bay_count
      FROM localised l
      ORDER BY l.start_at
    `;
  }
}

function toSlotView(row: SlotOccupancyRow): AvailabilitySlotView {
  return {
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
    // A booking needs both a technician and a bay; either at zero means no.
    available: row.technician_count > 0 && row.bay_count > 0,
    technicianCount: row.technician_count,
    bayCount: row.bay_count,
  };
}
