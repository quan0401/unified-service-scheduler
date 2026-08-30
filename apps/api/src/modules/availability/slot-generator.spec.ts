/**
 * Slot generation is pure -- no database, no ambient clock -- because this is
 * where scheduling systems actually break: timezone offsets, daylight saving
 * transitions, and services that would overrun closing time. Those cases are
 * cheap to assert here and expensive to reproduce through the API.
 */
import { generateSlots } from './slot-generator';

const OPEN_9_TO_17 = { openMinute: 9 * 60, closeMinute: 17 * 60 };

/** Renders slot starts as local wall-clock times, which is how a human reads a diary. */
function localStarts(slots: { startAt: Date }[], timeZone: string): string[] {
  return slots.map((slot) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(slot.startAt),
  );
}

describe('generateSlots', () => {
  describe('basic grid', () => {
    it('produces slots at the configured granularity across opening hours', () => {
      const slots = generateSlots({
        date: '2026-09-07', // a Monday
        timezone: 'Europe/London',
        openingHours: [{ dayOfWeek: 1, ...OPEN_9_TO_17 }],
        durationMinutes: 60,
        granularityMinutes: 60,
      });

      // 09:00 through 16:00 -- the 17:00 start is excluded because a 60-minute
      // service would finish after closing.
      expect(localStarts(slots, 'Europe/London')).toEqual([
        '09:00',
        '10:00',
        '11:00',
        '12:00',
        '13:00',
        '14:00',
        '15:00',
        '16:00',
      ]);
    });

    it('honours 15-minute granularity independently of service duration', () => {
      const slots = generateSlots({
        date: '2026-09-07',
        timezone: 'Europe/London',
        openingHours: [{ dayOfWeek: 1, openMinute: 9 * 60, closeMinute: 10 * 60 }],
        durationMinutes: 30,
        granularityMinutes: 15,
      });

      expect(localStarts(slots, 'Europe/London')).toEqual(['09:00', '09:15', '09:30']);
    });

    it('sets endAt to exactly the service duration after startAt', () => {
      const [slot] = generateSlots({
        date: '2026-09-07',
        timezone: 'Europe/London',
        openingHours: [{ dayOfWeek: 1, ...OPEN_9_TO_17 }],
        durationMinutes: 90,
        granularityMinutes: 60,
      });

      expect(slot.endAt.getTime() - slot.startAt.getTime()).toBe(90 * 60 * 1000);
    });
  });

  describe('closing time', () => {
    it('excludes a slot whose service would overrun closing time', () => {
      const slots = generateSlots({
        date: '2026-09-07',
        timezone: 'Europe/London',
        openingHours: [{ dayOfWeek: 1, openMinute: 9 * 60, closeMinute: 11 * 60 }],
        durationMinutes: 120,
        granularityMinutes: 30,
      });

      // Only a 09:00 start leaves room for a two-hour job before 11:00.
      expect(localStarts(slots, 'Europe/London')).toEqual(['09:00']);
    });

    it('returns nothing when the service cannot fit in the day at all', () => {
      const slots = generateSlots({
        date: '2026-09-07',
        timezone: 'Europe/London',
        openingHours: [{ dayOfWeek: 1, openMinute: 9 * 60, closeMinute: 10 * 60 }],
        durationMinutes: 240,
        granularityMinutes: 30,
      });

      expect(slots).toEqual([]);
    });

    it('includes a service that ends exactly at closing time', () => {
      const slots = generateSlots({
        date: '2026-09-07',
        timezone: 'Europe/London',
        openingHours: [{ dayOfWeek: 1, openMinute: 9 * 60, closeMinute: 10 * 60 }],
        durationMinutes: 60,
        granularityMinutes: 30,
      });

      expect(localStarts(slots, 'Europe/London')).toEqual(['09:00']);
    });
  });

  describe('closed days', () => {
    it('returns nothing when the dealership has no hours for that weekday', () => {
      const slots = generateSlots({
        date: '2026-09-13', // a Sunday
        timezone: 'Europe/London',
        openingHours: [{ dayOfWeek: 1, ...OPEN_9_TO_17 }],
        durationMinutes: 60,
        granularityMinutes: 60,
      });

      expect(slots).toEqual([]);
    });

    it('selects the opening hours matching the requested weekday', () => {
      const slots = generateSlots({
        date: '2026-09-12', // a Saturday
        timezone: 'Europe/London',
        openingHours: [
          { dayOfWeek: 1, ...OPEN_9_TO_17 },
          { dayOfWeek: 6, openMinute: 10 * 60, closeMinute: 12 * 60 },
        ],
        durationMinutes: 60,
        granularityMinutes: 60,
      });

      expect(localStarts(slots, 'Europe/London')).toEqual(['10:00', '11:00']);
    });
  });

  describe('timezones', () => {
    it('anchors slots to dealership-local time, not UTC', () => {
      // London is UTC+1 in September, so 09:00 local is 08:00Z.
      const [slot] = generateSlots({
        date: '2026-09-07',
        timezone: 'Europe/London',
        openingHours: [{ dayOfWeek: 1, ...OPEN_9_TO_17 }],
        durationMinutes: 60,
        granularityMinutes: 60,
      });

      expect(slot.startAt.toISOString()).toBe('2026-09-07T08:00:00.000Z');
    });

    it('produces different instants for the same local time in different zones', () => {
      const options = {
        date: '2026-09-07',
        openingHours: [{ dayOfWeek: 1, ...OPEN_9_TO_17 }],
        durationMinutes: 60,
        granularityMinutes: 60,
      };

      const [london] = generateSlots({ ...options, timezone: 'Europe/London' });
      const [losAngeles] = generateSlots({ ...options, timezone: 'America/Los_Angeles' });

      // 09:00 in London is 08:00Z; 09:00 in Los Angeles is 16:00Z.
      expect(london.startAt.toISOString()).toBe('2026-09-07T08:00:00.000Z');
      expect(losAngeles.startAt.toISOString()).toBe('2026-09-07T16:00:00.000Z');
    });
  });

  describe('daylight saving transitions', () => {
    it('produces one fewer hour of slots on a spring-forward day', () => {
      // 2026-03-29: London jumps 01:00 -> 02:00, so the local day is 23h long.
      const springForward = generateSlots({
        date: '2026-03-29',
        timezone: 'Europe/London',
        openingHours: [{ dayOfWeek: 7, openMinute: 0, closeMinute: 24 * 60 }],
        durationMinutes: 60,
        granularityMinutes: 60,
      });

      expect(springForward).toHaveLength(23);
    });

    it('produces one extra hour of slots on a fall-back day', () => {
      // 2026-10-25: London repeats 01:00-02:00, so the local day is 25h long.
      const fallBack = generateSlots({
        date: '2026-10-25',
        timezone: 'Europe/London',
        openingHours: [{ dayOfWeek: 7, openMinute: 0, closeMinute: 24 * 60 }],
        durationMinutes: 60,
        granularityMinutes: 60,
      });

      expect(fallBack).toHaveLength(25);
    });

    it('keeps every slot exactly one duration long across a DST boundary', () => {
      const slots = generateSlots({
        date: '2026-03-29',
        timezone: 'Europe/London',
        openingHours: [{ dayOfWeek: 7, openMinute: 0, closeMinute: 6 * 60 }],
        durationMinutes: 60,
        granularityMinutes: 60,
      });

      // Real elapsed time must stay constant even though local wall-clock
      // labels skip an hour -- an appointment is a duration, not a label.
      for (const slot of slots) {
        expect(slot.endAt.getTime() - slot.startAt.getTime()).toBe(60 * 60 * 1000);
      }
    });
  });

  describe('input validation', () => {
    it('rejects a non-positive duration', () => {
      expect(() =>
        generateSlots({
          date: '2026-09-07',
          timezone: 'Europe/London',
          openingHours: [{ dayOfWeek: 1, ...OPEN_9_TO_17 }],
          durationMinutes: 0,
          granularityMinutes: 30,
        }),
      ).toThrow(/duration/i);
    });

    it('rejects an unknown timezone rather than silently defaulting to UTC', () => {
      expect(() =>
        generateSlots({
          date: '2026-09-07',
          timezone: 'Mars/Olympus_Mons',
          openingHours: [{ dayOfWeek: 1, ...OPEN_9_TO_17 }],
          durationMinutes: 60,
          granularityMinutes: 30,
        }),
      ).toThrow(/timezone/i);
    });

    it('rejects a malformed date', () => {
      expect(() =>
        generateSlots({
          date: '07-09-2026',
          timezone: 'Europe/London',
          openingHours: [{ dayOfWeek: 1, ...OPEN_9_TO_17 }],
          durationMinutes: 60,
          granularityMinutes: 30,
        }),
      ).toThrow(/date/i);
    });
  });
});
