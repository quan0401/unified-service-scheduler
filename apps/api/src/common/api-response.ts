/**
 * Envelope constructors.
 *
 * The envelope *types* are published in @scheduler/contracts, because a client
 * needs to read this shape. These constructors are not: a client never builds
 * an envelope, so exporting them would widen the contract for no one's benefit.
 */
import type { ApiResponse, ApiErrorBody, ResponseMeta } from '@scheduler/contracts';

export type { ApiResponse, ApiErrorBody, ResponseMeta };

export function ok<T>(data: T, meta: ResponseMeta): ApiResponse<T> {
  return { success: true, data, error: null, meta };
}

export function fail(error: ApiErrorBody, meta: ResponseMeta): ApiResponse<never> {
  return { success: false, data: null, error, meta };
}
