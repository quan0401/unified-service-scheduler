import type { ApiResponse } from '@scheduler/contracts';
import { ApiError } from './ApiError';
import { API_BASE_URL } from '../lib/env';
import { newId } from '../lib/ids';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** Sent as Idempotency-Key. Reuse across retries -- that is the point of it. */
  idempotencyKey?: string;
  /** Correlation id. Generated when omitted; the API honours an inbound value. */
  requestId?: string;
  signal?: AbortSignal;
}

export interface Envelope<T> {
  data: T;
  /** From meta.requestId, which is readable regardless of CORS exposure. */
  requestId: string;
  status: number;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<Envelope<T>> {
  const requestId = options.requestId ?? newId();
  const headers: Record<string, string> = { 'X-Request-Id': requestId };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (cause) {
    // An abort is the caller's own doing, not an API failure. Let it through
    // untouched so useResource can ignore superseded requests.
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw ApiError.network(cause, requestId);
  }

  // DELETE /appointments/:id is 204. The envelope interceptor builds a body and
  // Express discards it, so there is nothing to parse.
  if (response.status === 204) {
    return { data: undefined as T, requestId, status: 204 };
  }

  const envelope = await readEnvelope(response, requestId);
  const resolvedId = envelope.meta?.requestId ?? requestId;

  if (response.ok && envelope.success === true) {
    return { data: envelope.data as T, requestId: resolvedId, status: response.status };
  }

  throw ApiError.fromBody(
    response.status,
    envelope.error ?? {
      code: 'INTERNAL_ERROR',
      message: `Unexpected ${response.status} response.`,
    },
    resolvedId,
  );
}

function buildUrl(path: string, query?: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') search.set(key, value);
  }
  const suffix = search.size > 0 ? `?${search.toString()}` : '';
  return `${API_BASE_URL}${path}${suffix}`;
}

/**
 * Tolerates a non-JSON body. A proxy 502 or a crashed process is not an
 * envelope, and throwing a SyntaxError there would hide the real failure.
 */
async function readEnvelope(
  response: Response,
  fallbackId: string,
): Promise<Partial<ApiResponse<unknown>>> {
  const text = await response.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as ApiResponse<unknown>;
  } catch {
    return {
      success: false,
      data: null,
      error: { code: 'NON_JSON_RESPONSE', message: text.slice(0, 200) },
      meta: { requestId: fallbackId },
    };
  }
}
