import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError } from '../api/ApiError';
import type { AsyncState } from './useAsync';

/**
 * Declarative keyed GET. A null key means "inputs not chosen yet" and fires
 * nothing, which is what keeps the availability request from running until a
 * dealership, service and date all exist.
 *
 * Deliberately not a cache. Availability is advisory, and silently serving a
 * stale slot grid would undercut the one thing this app exists to show -- every
 * refresh here is explicit and visible.
 */
export function useResource<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>,
): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({
    status: 'idle',
    data: null,
    error: null,
  });
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (key === null) {
      setState({ status: 'idle', data: null, error: null });
      return;
    }

    const controller = new AbortController();
    setState({ status: 'pending', data: null, error: null });

    loadRef
      .current(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ status: 'success', data, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (!isApiError(error)) throw error;
        setState({ status: 'error', data: null, error });
      });

    return () => controller.abort();
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { ...state, reload };
}
