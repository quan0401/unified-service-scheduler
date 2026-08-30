import type { ApiErrorBody, DomainErrorCode } from '@scheduler/contracts';

/**
 * Codes the API emits that are not domain errors. The exception filter derives
 * these from `HttpStatus[status]`, so 400 becomes BAD_REQUEST and 429 becomes
 * TOO_MANY_REQUESTS. NETWORK_ERROR and NON_JSON_RESPONSE are synthesised on the
 * client and never appear on the wire.
 */
export type TransportErrorCode =
  'BAD_REQUEST' | 'TOO_MANY_REQUESTS' | 'INTERNAL_ERROR' | 'NETWORK_ERROR' | 'NON_JSON_RESPONSE';

/** `string & {}` keeps autocomplete on both unions without closing the set. */
export type ApiErrorCode = DomainErrorCode | TransportErrorCode | (string & {});

export interface ApiErrorInit {
  status: number;
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
  requestId: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details?: Record<string, unknown>;
  /** From `meta.requestId`. Quote this when reading the server log. */
  readonly requestId: string;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.requestId = init.requestId;
  }

  static fromBody(status: number, body: ApiErrorBody, requestId: string): ApiError {
    return new ApiError({
      status,
      code: body.code,
      message: body.message,
      details: body.details as Record<string, unknown> | undefined,
      requestId,
    });
  }

  static network(cause: unknown, requestId: string): ApiError {
    return new ApiError({
      status: 0,
      code: 'NETWORK_ERROR',
      message: cause instanceof Error ? cause.message : 'The request never reached the API.',
      requestId,
    });
  }

  /**
   * SLOT_CONTENDED means the server exhausted its retries on a genuinely
   * simultaneous window, and 429 means the throttler intervened. Both are worth
   * retrying. SLOT_UNAVAILABLE is not -- the slot is simply gone.
   */
  get isRetryable(): boolean {
    return this.code === 'SLOT_CONTENDED' || this.status === 429;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
