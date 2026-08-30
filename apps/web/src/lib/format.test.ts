import { describe, expect, it } from 'vitest';
import { formatCountdown, formatMinuteOfDay, formatSlotDate, formatSlotTime } from './format';

// The app's only timezone logic. A bug here looks right and is wrong -- the
// dealership would open an hour late, or a slot would render on the wrong day.

describe('formatSlotTime', () => {
  it('renders a UTC instant in the dealership zone, not the viewer zone', () => {
    // 06:30Z on 2026-09-07 is 07:30 in London (BST, UTC+1) -- the first
    // Northgate slot in the cURL walkthrough.
    expect(formatSlotTime('2026-09-07T06:30:00.000Z', 'Europe/London')).toBe('07:30');
  });

  it('handles a zone behind UTC, where the local date differs', () => {
    expect(formatSlotTime('2026-09-07T06:30:00.000Z', 'America/Los_Angeles')).toBe('23:30');
    expect(formatSlotDate('2026-09-07T06:30:00.000Z', 'America/Los_Angeles')).toContain('6 Sep');
  });

  it('uses a 24-hour clock rather than midnight rolling to 24', () => {
    expect(formatSlotTime('2026-09-07T00:00:00.000Z', 'UTC')).toBe('00:00');
  });
});

describe('formatMinuteOfDay', () => {
  it('renders minutes from local midnight as wall-clock time', () => {
    expect(formatMinuteOfDay(450)).toBe('07:30');
    expect(formatMinuteOfDay(1050)).toBe('17:30');
  });
});

describe('formatCountdown', () => {
  it('pads seconds and never goes negative', () => {
    expect(formatCountdown(120_000)).toBe('2:00');
    expect(formatCountdown(9_000)).toBe('0:09');
    expect(formatCountdown(-500)).toBe('0:00');
  });
});
