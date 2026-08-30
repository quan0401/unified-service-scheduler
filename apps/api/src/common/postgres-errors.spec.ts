/**
 * Classification of the SQLSTATEs a contended booking can fail with.
 *
 * The cases that matter are the timeout ones. A live 20-way race against the
 * deployed instance produced three HTTP 500s alongside sixteen clean 409s,
 * because `55P03` and `57014` were not recognised as contention and fell
 * through to the unhandled-exception path.
 */
import {
  isContentionTimeout,
  isPoolTimeout,
  isDeadlock,
  isExclusionViolation,
  isLostRace,
  isUniqueViolation,
  violatedConstraintName,
} from './postgres-errors';

/** How Prisma reports a SQLSTATE from `$queryRaw`. */
const rawError = (sqlState: string, message = '') => ({
  code: 'P2010',
  meta: { code: sqlState },
  message,
});

/** How Prisma reports the same thing from a typed client call. */
const typedError = (message: string) => ({ message });

describe('postgres error classification', () => {
  describe('isExclusionViolation', () => {
    it('recognises 23P01 from a raw query', () => {
      expect(isExclusionViolation(rawError('23P01'))).toBe(true);
    });

    it('recognises 23P01 embedded in a typed-client message', () => {
      expect(
        isExclusionViolation(
          typedError('conflicting key value violates exclusion constraint 23P01'),
        ),
      ).toBe(true);
    });

    it('does not match an unrelated SQLSTATE', () => {
      expect(isExclusionViolation(rawError('23505'))).toBe(false);
    });
  });

  describe('isUniqueViolation', () => {
    it('recognises 23505', () => {
      expect(isUniqueViolation(rawError('23505'))).toBe(true);
    });
  });

  describe('isDeadlock', () => {
    it('recognises 40P01', () => {
      expect(isDeadlock(rawError('40P01'))).toBe(true);
    });
  });

  describe('isLostRace', () => {
    it.each([
      ['exclusion violation', '23P01'],
      ['deadlock', '40P01'],
    ])('treats %s as a lost race, because retrying can still win', (_label, sqlState) => {
      expect(isLostRace(rawError(sqlState))).toBe(true);
    });

    it.each([
      ['lock timeout', '55P03'],
      ['statement timeout', '57014'],
    ])('does NOT treat %s as a lost race', (_label, sqlState) => {
      // Retrying after the full timeout budget has already been spent would
      // queue behind the same holder and pay the same wait again.
      expect(isLostRace(rawError(sqlState))).toBe(false);
    });
  });

  describe('isContentionTimeout', () => {
    it('recognises 55P03, lock_not_available', () => {
      expect(
        isContentionTimeout(rawError('55P03', 'canceling statement due to lock timeout')),
      ).toBe(true);
    });

    it('recognises 57014, query_canceled', () => {
      expect(
        isContentionTimeout(rawError('57014', 'canceling statement due to statement timeout')),
      ).toBe(true);
    });

    it.each([
      ['exclusion violation', '23P01'],
      ['deadlock', '40P01'],
      ['unique violation', '23505'],
    ])('does not classify %s as a timeout', (_label, sqlState) => {
      expect(isContentionTimeout(rawError(sqlState))).toBe(false);
    });

    it('ignores values that are not errors at all', () => {
      expect(isContentionTimeout(null)).toBe(false);
      expect(isContentionTimeout(undefined)).toBe(false);
      expect(isContentionTimeout('57014')).toBe(false);
    });
  });

  describe('isPoolTimeout', () => {
    // P2024 is raised by Prisma itself, client-side, so it carries no SQLSTATE:
    // the query never reached PostgreSQL at all.
    const poolError = {
      code: 'P2024',
      meta: { connection_limit: 3, timeout: 10 },
      message: 'Timed out fetching a new connection from the connection pool.',
    };

    it('recognises P2024', () => {
      expect(isPoolTimeout(poolError)).toBe(true);
    });

    it('is not confused with a contention timeout', () => {
      expect(isContentionTimeout(poolError)).toBe(false);
      expect(isLostRace(poolError)).toBe(false);
    });

    it('does not fire on the SQLSTATE-carrying errors', () => {
      expect(isPoolTimeout(rawError('57014'))).toBe(false);
      expect(isPoolTimeout(rawError('23P01'))).toBe(false);
    });

    it('ignores values that are not errors', () => {
      expect(isPoolTimeout(null)).toBe(false);
      expect(isPoolTimeout('P2024')).toBe(false);
    });
  });

  describe('violatedConstraintName', () => {
    it('extracts the name from a plainly quoted message', () => {
      expect(
        violatedConstraintName(
          typedError('conflicting key value violates exclusion constraint "appointment_no_bay_overlap"'),
        ),
      ).toBe('appointment_no_bay_overlap');
    });

    it('extracts the name through Rust debug escaping', () => {
      expect(
        violatedConstraintName(
          typedError('violates exclusion constraint \\"appointment_no_technician_overlap\\"'),
        ),
      ).toBe('appointment_no_technician_overlap');
    });

    it('returns undefined when no constraint is named', () => {
      expect(violatedConstraintName(typedError('canceling statement due to lock timeout'))).toBeUndefined();
    });
  });
});
