/**
 * Detection of PostgreSQL error conditions across Prisma's inconsistent shapes.
 *
 * Prisma reports the same underlying SQLSTATE two different ways depending on
 * how the query was issued:
 *
 *   - `$queryRaw` / `$executeRaw` -> PrismaClientKnownRequestError with
 *     code 'P2010' and `meta.code` holding the SQLSTATE.
 *   - Typed client calls (`prisma.appointment.create`) ->
 *     PrismaClientUnknownRequestError, where the SQLSTATE appears only inside
 *     the message text.
 *
 * Booking issues raw SQL and tests use the typed client, so both paths must be
 * recognised. Matching on the SQLSTATE rather than on message wording keeps this
 * stable across Prisma versions and locales.
 */

/** exclusion_violation -- the double-booking guard rejecting an overlap. */
export const EXCLUSION_VIOLATION = '23P01';

/** unique_violation -- e.g. a replayed idempotency key. */
export const UNIQUE_VIOLATION = '23505';

/**
 * deadlock_detected -- the other way a booking can lose a race.
 *
 * An exclusion constraint does not reject a conflicting row at insert time. It
 * is index-backed and detects the conflict in a scan performed *after* the
 * tuple is written, so a second inserter finds an in-progress tuple and waits
 * on the first transaction's outcome. When two backends do that to each other
 * simultaneously, neither can proceed and PostgreSQL resolves it by aborting
 * one of them with this SQLSTATE.
 *
 * The aborted request lost a race exactly as surely as one rejected with 23P01.
 * Treating it as an unexpected fault would turn an ordinary contention outcome
 * into a 500, which is why the booking loop retries on it.
 */
export const DEADLOCK_DETECTED = '40P01';

/**
 * lock_not_available -- `lock_timeout` elapsed while waiting on a competitor.
 *
 * Set deliberately (DB_LOCK_TIMEOUT_MS) so a contended booking fails fast
 * instead of queueing. Without it the request would block for as long as the
 * winner's transaction runs.
 */
export const LOCK_NOT_AVAILABLE = '55P03';

/**
 * query_canceled -- `statement_timeout` elapsed.
 *
 * On the booking statement this means the same thing as 55P03: the insert sat
 * behind another backend's exclusion-constraint lock until the budget ran out.
 * The code is more general than that in principle -- a genuinely slow query
 * raises it too -- which is why only the booking path treats it as contention,
 * and everything else still surfaces it as a fault.
 */
export const QUERY_CANCELED = '57014';

interface PrismaLikeError {
  code?: unknown;
  meta?: { code?: unknown };
  message?: unknown;
}

function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as PrismaLikeError;

  const metaCode = candidate.meta?.code;
  if (typeof metaCode === 'string') return metaCode;

  // Fall back to scanning the message for a bare five-character SQLSTATE.
  if (typeof candidate.message === 'string') {
    const match = /\b(\d{2}[0-9A-Z]{3})\b/.exec(candidate.message);
    if (match) return match[1];
  }
  return undefined;
}

export function isPostgresError(error: unknown, sqlState: string): boolean {
  return sqlStateOf(error) === sqlState;
}

/**
 * True when the database refused a write because it would have overlapped an
 * existing booking. This is the expected, non-exceptional outcome of losing a
 * race for a slot -- the caller retries or reports a conflict rather than
 * treating it as a failure.
 */
export function isExclusionViolation(error: unknown): boolean {
  return isPostgresError(error, EXCLUSION_VIOLATION);
}

export function isUniqueViolation(error: unknown): boolean {
  return isPostgresError(error, UNIQUE_VIOLATION);
}

/** True when the database aborted this transaction to break a deadlock. */
export function isDeadlock(error: unknown): boolean {
  return isPostgresError(error, DEADLOCK_DETECTED);
}

/**
 * True when the write failed because another booking got there first, by either
 * mechanism the database uses to say so.
 *
 * Callers care about "lost the race, try again", not about which of the two
 * SQLSTATEs reported it -- so the distinction is resolved here rather than
 * duplicated at every retry site.
 */
export function isLostRace(error: unknown): boolean {
  return isExclusionViolation(error) || isDeadlock(error);
}

/**
 * Prisma's code for exhausting the client connection pool.
 *
 * Not a SQLSTATE -- the query never reached PostgreSQL, so there is nothing for
 * the database to report. Prisma raises it from the client side after
 * `pool_timeout` elapses with every connection busy.
 */
export const POOL_TIMEOUT = 'P2024';

/**
 * True when the request never got a database connection.
 *
 * Distinct from every SQLSTATE case here: those mean the database considered
 * the write and refused it, whereas this means the write was never attempted.
 * The slot may well be free. Reporting it as contention would be a lie that
 * hides a capacity problem behind an ordinary-looking 409.
 */
export function isPoolTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === POOL_TIMEOUT
  );
}

/**
 * True when the database gave up waiting rather than resolving the conflict.
 *
 * Distinct from `isLostRace` in the one way that matters to a caller: a lost
 * race is worth retrying, because the resource we picked was taken but another
 * may still be free. A timeout is not. The request has already spent its entire
 * lock or statement budget queued behind the same holder, so a retry buys
 * another full wait and returns the same answer later.
 *
 * Observed live: a 20-way race for one bay produced sixteen clean 409s and
 * three HTTP 500s, the latter being these two SQLSTATEs falling through to the
 * unhandled-exception path after 11, 16, and 21 seconds.
 */
export function isContentionTimeout(error: unknown): boolean {
  return (
    isPostgresError(error, LOCK_NOT_AVAILABLE) || isPostgresError(error, QUERY_CANCELED)
  );
}

/**
 * Names the specific constraint that rejected the write, when available.
 *
 * The quote handling is deliberately loose. Typed-client errors embed the
 * Postgres message through Rust debug formatting, so the constraint name
 * arrives wrapped in escaped quotes (\") rather than plain ones. Matching the
 * identifier characters directly sidesteps that difference.
 */
export function violatedConstraintName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const message = (error as PrismaLikeError).message;
  if (typeof message !== 'string') return undefined;
  return /(?:exclusion|unique) constraint \\?"?([a-zA-Z0-9_]+)/.exec(message)?.[1];
}
