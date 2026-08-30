import { useEffect, useState } from 'react';

export interface Countdown {
  remainingMs: number;
  /** 1 at the start, 0 at expiry. Drives a scaleX bar. */
  fraction: number;
  expired: boolean;
}

/**
 * Counts down to a client-side deadline. Using `receivedAt + ttl` rather than
 * the server's `holdExpiresAt` makes the display immune to clock skew between
 * browser and server; the server's value stays the authority for the actual
 * verdict, which arrives as a 409 HOLD_EXPIRED.
 */
export function useCountdown(deadlineMs: number | null, totalMs: number): Countdown {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadlineMs === null) return;
    // 250ms so the seconds digit never visibly skips.
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [deadlineMs]);

  if (deadlineMs === null) {
    return { remainingMs: 0, fraction: 0, expired: false };
  }

  const remainingMs = Math.max(0, deadlineMs - now);
  return {
    remainingMs,
    fraction: totalMs > 0 ? remainingMs / totalMs : 0,
    expired: remainingMs === 0,
  };
}
