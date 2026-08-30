/**
 * Tolerant reading of numeric configuration.
 *
 * `Number(process.env.X ?? fallback)` looks safe and is not: any non-numeric
 * value yields NaN, which propagates silently rather than failing. The two
 * places this mattered here fail in different directions, which is why the
 * guard is shared rather than inlined at each site:
 *
 *   - HOLD_TTL_SECONDS=abc produced an Invalid Date for `hold_expires_at`,
 *     rejected by the database as a 500 on an otherwise valid request.
 *   - THROTTLE_BURST_LIMIT=abc produced a rate limiter with a NaN ceiling,
 *     which silently stops limiting anything.
 *
 * A bad value falls back to the default and says so, on the reasoning that a
 * typo in configuration should degrade to the documented behaviour rather than
 * take the service down or quietly disable a control.
 */
import { Logger } from '@nestjs/common';

const logger = new Logger('Config');

/**
 * Reads an environment variable as a positive integer.
 *
 * Returns `fallback` when the variable is unset, blank, non-numeric,
 * fractional, or not greater than zero. Pure apart from the warning, so the
 * parsing rules are testable without booting the application.
 */
export function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    logger.warn(
      `${name}="${raw}" is not a positive whole number. Falling back to ${fallback}.`,
    );
    return fallback;
  }

  return parsed;
}
