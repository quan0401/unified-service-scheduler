import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/ApiError';
import { bucketOf, tally, type RaceBucket } from './raceBuckets';

// This function is the demo's entire claim expressed as code. A wrong answer
// here would be invisible on camera -- the tiles would still look plausible.

const error = (status: number, code: string) =>
  new ApiError({ status, code, message: '', requestId: 'r' });

describe('bucketOf', () => {
  it('separates the two 409s, which mean different things', () => {
    expect(bucketOf(error(409, 'SLOT_UNAVAILABLE'))).toBe('slot-unavailable');
    expect(bucketOf(error(409, 'SLOT_CONTENDED'))).toBe('slot-contended');
  });

  it('buckets 429 as throttled despite its generic code', () => {
    // The exception filter derives this code from HttpStatus[429], so it is not
    // a DomainErrorCode. Matching on the code alone would drop it into `other`
    // and silently overstate the conflict count.
    expect(bucketOf(error(429, 'TOO_MANY_REQUESTS'))).toBe('throttled');
  });

  it('buckets a rate-limited response on status even if the code is unfamiliar', () => {
    expect(bucketOf(error(429, 'SOMETHING_ELSE'))).toBe('throttled');
  });

  it('routes hold expiry to its own bucket rather than the conflict count', () => {
    expect(bucketOf(error(409, 'HOLD_EXPIRED'))).toBe('hold-expired');
  });

  it('falls back to other for anything unrecognised', () => {
    expect(bucketOf(error(500, 'INTERNAL_ERROR'))).toBe('other');
    expect(bucketOf(error(0, 'NETWORK_ERROR'))).toBe('other');
    expect(bucketOf(error(400, 'BAD_REQUEST'))).toBe('other');
  });
});

describe('tally', () => {
  it('counts every bucket, including the ones with no entries', () => {
    const buckets: RaceBucket[] = ['created', 'slot-unavailable', 'slot-unavailable', 'throttled'];

    expect(tally(buckets)).toEqual({
      created: 1,
      'slot-unavailable': 2,
      'slot-contended': 0,
      'hold-expired': 0,
      throttled: 1,
      other: 0,
    });
  });
});
