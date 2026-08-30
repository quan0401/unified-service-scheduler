import { describe, expect, it } from 'vitest';
import { ApiError } from './ApiError';
import { copyFor } from './messages';

// Exhaustiveness over DomainErrorCode is enforced at compile time by the mapped
// type in messages.ts, so there is nothing to assert about it at runtime. What
// is worth pinning down is the behaviour for codes the map does not contain.

describe('copyFor', () => {
  it('distinguishes the two 409s that mean different things', () => {
    const unavailable = copyFor(
      new ApiError({ status: 409, code: 'SLOT_UNAVAILABLE', message: '', requestId: 'r' }),
    );
    const contended = copyFor(
      new ApiError({ status: 409, code: 'SLOT_CONTENDED', message: '', requestId: 'r' }),
    );

    expect(unavailable.title).not.toBe(contended.title);
    expect(contended.recovery).toBe('Try again');
    expect(unavailable.recovery).not.toBe('Try again');
  });

  it('translates transport codes that are not domain errors', () => {
    const throttled = copyFor(
      new ApiError({ status: 429, code: 'TOO_MANY_REQUESTS', message: '', requestId: 'r' }),
    );

    expect(throttled.title).toBe('Rate limited');
    expect(throttled.body).toContain('not a booking conflict');
  });

  it('falls back to the server message for an unrecognised code', () => {
    const copy = copyFor(
      new ApiError({
        status: 418,
        code: 'SOMETHING_NEW',
        message: 'Teapot refused the booking.',
        requestId: 'r',
      }),
    );

    expect(copy.title).toBe('Request failed');
    expect(copy.body).toBe('Teapot refused the booking.');
  });
});
