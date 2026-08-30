import type { ApiError } from '../../api/ApiError';

export type RaceBucket =
  'created' | 'slot-unavailable' | 'slot-contended' | 'hold-expired' | 'throttled' | 'other';

export interface BucketMeta {
  label: string;
  description: string;
  tone: 'success' | 'taken' | 'held' | 'info' | 'neutral';
}

export const BUCKET_ORDER: readonly RaceBucket[] = [
  'created',
  'slot-unavailable',
  'slot-contended',
  'hold-expired',
  'throttled',
  'other',
] as const;

export const BUCKET_META: Record<RaceBucket, BucketMeta> = {
  created: {
    label: '201 created',
    description: 'The winner. There can only ever be one.',
    tone: 'success',
  },
  'slot-unavailable': {
    label: '409 slot taken',
    description:
      'The expected loser. The winner committed before these reached the availability filter.',
    tone: 'taken',
  },
  'slot-contended': {
    label: '409 contended',
    description:
      'Lost all three server-side attempts at the exclusion constraint. Normally zero — the constraint is the backstop, not the everyday path.',
    tone: 'held',
  },
  'hold-expired': {
    label: '409 hold expired',
    description: 'The reservation lapsed before confirmation.',
    tone: 'held',
  },
  throttled: {
    label: '429 rate limited',
    description:
      'The per-IP rate limiter, not the booking constraint. These prove nothing about concurrency.',
    tone: 'info',
  },
  other: {
    label: 'other',
    description: 'Network failures, 5xx, or validation errors.',
    tone: 'neutral',
  },
};

/**
 * Classify one failed attempt.
 *
 * Status is checked before code deliberately: a 429's code is the generic
 * TOO_MANY_REQUESTS derived from HttpStatus[429] by the exception filter, not a
 * domain error, so bucketing on status is the robust check.
 */
export function bucketOf(error: ApiError): RaceBucket {
  if (error.status === 429) return 'throttled';

  switch (error.code) {
    case 'SLOT_UNAVAILABLE':
      return 'slot-unavailable';
    case 'SLOT_CONTENDED':
      return 'slot-contended';
    case 'HOLD_EXPIRED':
      return 'hold-expired';
    default:
      return 'other';
  }
}

export function tally(buckets: readonly RaceBucket[]): Record<RaceBucket, number> {
  const counts: Record<RaceBucket, number> = {
    created: 0,
    'slot-unavailable': 0,
    'slot-contended': 0,
    'hold-expired': 0,
    throttled: 0,
    other: 0,
  };
  for (const bucket of buckets) counts[bucket] += 1;
  return counts;
}
