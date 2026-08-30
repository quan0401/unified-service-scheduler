/**
 * Per-request correlation ID, carried through AsyncLocalStorage.
 *
 * Passing the ID down through call signatures would couple every service to
 * transport concerns; ambient context keeps logs, metrics, and error responses
 * correlatable without threading a parameter through the domain layer.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, callback: () => T): T {
  return storage.run(context, callback);
}

/** Returns the active request ID, or a fresh one outside a request (jobs, tests). */
export function currentRequestId(): string {
  return storage.getStore()?.requestId ?? randomUUID();
}
