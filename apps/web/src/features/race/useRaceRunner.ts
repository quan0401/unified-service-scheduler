import { useCallback, useState } from 'react';
import type { CreateAppointmentRequest } from '@scheduler/contracts';
import { ApiError, isApiError } from '../../api/ApiError';
import { api } from '../../api/endpoints';
import type { AppointmentRecord } from '../../api/types';
import { bucketOf, tally, type RaceBucket } from './raceBuckets';

export interface RaceAttempt {
  index: number;
  /** ms after t0 that fetch() was invoked. */
  dispatchedAt: number;
  /** ms after t0 that the response settled. */
  settledAt: number;
  status: number;
  code: string | null;
  bucket: RaceBucket;
  appointmentId: string | null;
}

export interface RaceResult {
  attempts: RaceAttempt[];
  counts: Record<RaceBucket, number>;
  /** Counted from the server, not from the buckets. */
  confirmedOnServer: AppointmentRecord[] | null;
  totalMs: number;
}

export interface RaceRunner {
  running: boolean;
  result: RaceResult | null;
  error: ApiError | null;
  run: (body: CreateAppointmentRequest, count: number) => Promise<void>;
  reset: () => void;
}

export function useRaceRunner(): RaceRunner {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RaceResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const run = useCallback(async (body: CreateAppointmentRequest, count: number) => {
    setRunning(true);
    setError(null);
    setResult(null);

    // Warm up. Without this the first request pays a TCP handshake and a module
    // resolve the rest skip, and it loses a race it should have won.
    await api.health().catch(() => undefined);

    const t0 = performance.now();
    const attempts: RaceAttempt[] = [];

    // Dispatch in one synchronous tick: fetch() is invoked for all N before any
    // continuation runs. Nothing in this loop awaits.
    //
    // No Idempotency-Key is sent -- deduplicating the requests would delete the
    // very race this screen exists to show.
    const inFlight = Array.from({ length: count }, (_, index) => {
      const dispatchedAt = performance.now() - t0;

      return api
        .createAppointment(body, { requestId: `race-${index}-${crypto.randomUUID()}` })
        .then((response) => {
          attempts.push({
            index,
            dispatchedAt,
            settledAt: performance.now() - t0,
            status: response.status,
            code: null,
            bucket: 'created' as RaceBucket,
            appointmentId: response.data.id,
          });
        })
        .catch((cause: unknown) => {
          const apiError = isApiError(cause) ? cause : ApiError.network(cause, `race-${index}`);
          attempts.push({
            index,
            dispatchedAt,
            settledAt: performance.now() - t0,
            status: apiError.status,
            code: String(apiError.code),
            bucket: bucketOf(apiError),
            appointmentId: null,
          });
        });
    });

    await Promise.allSettled(inFlight);
    const totalMs = performance.now() - t0;

    // Independent verification. Do not trust the buckets -- ask the server what
    // actually exists. The tiles illustrate; this asserts.
    let confirmedOnServer: AppointmentRecord[] | null = null;
    try {
      const listed = await api.listAppointments(body.customerId);
      confirmedOnServer = listed.data.filter(
        (a) => a.startAt === body.startAt && a.status === 'CONFIRMED',
      );
    } catch (cause) {
      if (isApiError(cause)) setError(cause);
    }

    const ordered = [...attempts].sort((a, b) => a.index - b.index);
    setResult({
      attempts: ordered,
      counts: tally(ordered.map((a) => a.bucket)),
      confirmedOnServer,
      totalMs,
    });
    setRunning(false);
  }, []);

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return { running, result, error, run, reset };
}
