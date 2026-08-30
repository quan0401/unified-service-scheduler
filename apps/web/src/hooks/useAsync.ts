import { useCallback, useRef, useState } from 'react';
import { ApiError, isApiError } from '../api/ApiError';

export type AsyncState<T> =
  | { status: 'idle'; data: null; error: null }
  | { status: 'pending'; data: null; error: null }
  | { status: 'success'; data: T; error: null }
  | { status: 'error'; data: null; error: ApiError };

export interface AsyncHandle<A extends unknown[], T> {
  state: AsyncState<T>;
  /** Resolves to null on failure, so callers can branch without try/catch. */
  run: (...args: A) => Promise<T | null>;
  reset: () => void;
}

const IDLE = { status: 'idle', data: null, error: null } as const;

/** Imperative async state, for mutations the user triggers. */
export function useAsync<A extends unknown[], T>(
  fn: (...args: A) => Promise<T>,
): AsyncHandle<A, T> {
  const [state, setState] = useState<AsyncState<T>>(IDLE);
  const runIdRef = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(async (...args: A): Promise<T | null> => {
    const runId = ++runIdRef.current;
    setState({ status: 'pending', data: null, error: null });
    try {
      const data = await fnRef.current(...args);
      // A superseded call must not overwrite a newer result.
      if (runId !== runIdRef.current) return null;
      setState({ status: 'success', data, error: null });
      return data;
    } catch (error) {
      if (runId !== runIdRef.current) return null;
      if (!isApiError(error)) throw error;
      setState({ status: 'error', data: null, error });
      return null;
    }
  }, []);

  const reset = useCallback(() => {
    runIdRef.current += 1;
    setState(IDLE);
  }, []);

  return { state, run, reset };
}
