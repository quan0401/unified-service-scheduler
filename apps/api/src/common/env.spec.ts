/**
 * Parsing rules for numeric configuration.
 *
 * These cases are cheap to write and were not hypothetical: `Number()` returns
 * NaN for a typo, and the two call sites failed in opposite directions -- one
 * by rejecting valid requests, the other by silently disabling a rate limit.
 */
import { readPositiveInt } from './env';

const VARIABLE = 'TEST_POSITIVE_INT';
const FALLBACK = 120;

describe('readPositiveInt', () => {
  afterEach(() => {
    delete process.env[VARIABLE];
  });

  it('returns the configured value when it is a positive whole number', () => {
    // Arrange
    process.env[VARIABLE] = '45';

    // Act
    const value = readPositiveInt(VARIABLE, FALLBACK);

    // Assert
    expect(value).toBe(45);
  });

  it('falls back when the variable is unset', () => {
    expect(readPositiveInt(VARIABLE, FALLBACK)).toBe(FALLBACK);
  });

  it('falls back when the variable is blank or whitespace', () => {
    process.env[VARIABLE] = '   ';
    expect(readPositiveInt(VARIABLE, FALLBACK)).toBe(FALLBACK);
  });

  // The original defect: this produced NaN, which became an Invalid Date on
  // hold_expires_at and a 500 on an otherwise valid booking request.
  it('falls back on a non-numeric value rather than yielding NaN', () => {
    process.env[VARIABLE] = 'abc';
    expect(readPositiveInt(VARIABLE, FALLBACK)).toBe(FALLBACK);
  });

  it('falls back on zero', () => {
    process.env[VARIABLE] = '0';
    expect(readPositiveInt(VARIABLE, FALLBACK)).toBe(FALLBACK);
  });

  it('falls back on a negative value', () => {
    process.env[VARIABLE] = '-5';
    expect(readPositiveInt(VARIABLE, FALLBACK)).toBe(FALLBACK);
  });

  // A fractional TTL or rate limit is a configuration mistake, not a rounding
  // opportunity -- silently truncating it would hide the typo.
  it('falls back on a fractional value', () => {
    process.env[VARIABLE] = '1.5';
    expect(readPositiveInt(VARIABLE, FALLBACK)).toBe(FALLBACK);
  });
});
