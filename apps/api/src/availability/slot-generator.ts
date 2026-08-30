/**
 * Candidate appointment slots for one dealership on one local calendar date.
 *
 * Pure by design: no database, no ambient clock, no I/O. Every input is
 * explicit, so the awkward cases -- daylight saving transitions, services that
 * would overrun closing time, dealerships in other timezones -- are directly
 * testable rather than reachable only through an integrated stack.
 *
 * The function answers "which slots could exist", never "which are free".
 * Occupancy is a database question and is answered separately, which keeps this
 * logic independent of contention and trivially cacheable.
 */
import { DateTime } from 'luxon';

/** Minutes from local midnight, e.g. 480 = 08:00. */
export interface OpeningHourWindow {
  /** ISO-8601 weekday: 1 = Monday .. 7 = Sunday. */
  dayOfWeek: number;
  openMinute: number;
  closeMinute: number;
}

export interface GenerateSlotsOptions {
  /** Local calendar date at the dealership, `YYYY-MM-DD`. */
  date: string;
  /** IANA timezone identifier, e.g. `Europe/London`. */
  timezone: string;
  openingHours: OpeningHourWindow[];
  /** How long the requested service takes; fixes each slot's end. */
  durationMinutes: number;
  /** Spacing between consecutive slot starts. */
  granularityMinutes: number;
}

export interface Slot {
  startAt: Date;
  endAt: Date;
  /**
   * Local weekday and minutes-from-midnight at the dealership.
   *
   * Carried alongside the instant so shift matching never has to recompute a
   * timezone conversion in SQL. Keeping every timezone decision inside Luxon
   * means availability and booking cannot disagree about which local day a
   * given instant falls on -- a divergence that would show up only near
   * midnight and only in some zones.
   */
  dayOfWeek: number;
  startMinute: number;
}

const MINUTES_PER_DAY = 24 * 60;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function generateSlots(options: GenerateSlotsOptions): Slot[] {
  const { date, timezone, openingHours, durationMinutes, granularityMinutes } = options;

  validate(options);

  const startOfDay = DateTime.fromISO(date, { zone: timezone }).startOf('day');
  const window = openingHours.find((hours) => hours.dayOfWeek === startOfDay.weekday);
  if (!window) return []; // Closed that weekday.

  // Opening hours are wall-clock times ("we close at 18:00 local"), not elapsed
  // time since midnight. The distinction only shows up on daylight saving
  // transition days, where the local day is 23 or 25 hours long -- treating
  // 18:00 as "midnight plus 1080 minutes" would open the dealership an hour
  // late every spring.
  const opensAt = wallClock(startOfDay, window.openMinute);
  const closesAt = wallClock(startOfDay, window.closeMinute);

  const slots: Slot[] = [];

  // Stepping is elapsed time, deliberately: an appointment occupies a real
  // duration, so a 60-minute service is 60 real minutes even when the local
  // clock jumps during it.
  for (
    let startAt = opensAt;
    startAt.plus({ minutes: durationMinutes }) <= closesAt;
    startAt = startAt.plus({ minutes: granularityMinutes })
  ) {
    slots.push({
      startAt: startAt.toJSDate(),
      endAt: startAt.plus({ minutes: durationMinutes }).toJSDate(),
      dayOfWeek: startAt.weekday,
      startMinute: startAt.hour * 60 + startAt.minute,
    });
  }

  return slots;
}

/**
 * Resolves minutes-from-local-midnight to the corresponding local wall-clock
 * instant on that date. A closing time of 1440 means the following local
 * midnight, which is how "open until end of day" is expressed.
 */
function wallClock(startOfDay: DateTime, minutes: number): DateTime {
  if (minutes >= MINUTES_PER_DAY) {
    return startOfDay
      .plus({ days: 1 })
      .startOf('day')
      .plus({ minutes: minutes - MINUTES_PER_DAY });
  }
  return startOfDay.set({
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
    second: 0,
    millisecond: 0,
  });
}

function validate({
  date,
  timezone,
  durationMinutes,
  granularityMinutes,
  openingHours,
}: GenerateSlotsOptions): void {
  if (!ISO_DATE.test(date)) {
    throw new RangeError(`Invalid date "${date}": expected format YYYY-MM-DD.`);
  }
  if (!DateTime.fromISO(date, { zone: timezone }).isValid) {
    // Luxon reports an unknown zone and an impossible calendar date the same
    // way, so the message names both possibilities rather than guessing.
    throw new RangeError(`Invalid date or timezone: "${date}" in "${timezone}".`);
  }
  if (!DateTime.local().setZone(timezone).isValid) {
    throw new RangeError(`Unknown timezone: "${timezone}".`);
  }
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
    throw new RangeError(`Service duration must be a positive whole number of minutes.`);
  }
  if (!Number.isInteger(granularityMinutes) || granularityMinutes <= 0) {
    throw new RangeError(`Slot granularity must be a positive whole number of minutes.`);
  }
  for (const { dayOfWeek, openMinute, closeMinute } of openingHours) {
    if (dayOfWeek < 1 || dayOfWeek > 7) {
      throw new RangeError(`Invalid dayOfWeek ${dayOfWeek}: expected 1 (Monday) to 7 (Sunday).`);
    }
    if (openMinute < 0 || closeMinute > MINUTES_PER_DAY || openMinute >= closeMinute) {
      throw new RangeError(
        `Invalid opening hours for day ${dayOfWeek}: ${openMinute}-${closeMinute}.`,
      );
    }
  }
}

/**
 * Local weekday and minutes-from-midnight for an arbitrary instant.
 *
 * Booking accepts any requested time, not only generated slot boundaries, so it
 * needs the same local fields the generator attaches to slots. Sharing this
 * helper is what keeps the two paths consistent.
 */
export function localFieldsAt(
  instant: Date,
  timezone: string,
): { dayOfWeek: number; startMinute: number } {
  const local = DateTime.fromJSDate(instant, { zone: timezone });
  if (!local.isValid) throw new RangeError(`Unknown timezone: "${timezone}".`);
  return { dayOfWeek: local.weekday, startMinute: local.hour * 60 + local.minute };
}

/**
 * Whether a service of the given duration fits entirely inside the dealership's
 * opening hours for the requested instant.
 *
 * Booking must reject an out-of-hours request even though no slot would ever
 * have offered it, because the API accepts arbitrary desired times.
 */
export function isWithinOpeningHours(
  startAt: Date,
  durationMinutes: number,
  timezone: string,
  openingHours: OpeningHourWindow[],
): boolean {
  const local = DateTime.fromJSDate(startAt, { zone: timezone });
  const window = openingHours.find((hours) => hours.dayOfWeek === local.weekday);
  if (!window) return false;

  const startMinute = local.hour * 60 + local.minute;
  return (
    startMinute >= window.openMinute && startMinute + durationMinutes <= window.closeMinute
  );
}
