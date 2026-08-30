/**
 * Uniform response envelope.
 *
 * Every response -- success or failure -- has the same top-level shape, so a
 * client never has to branch on status code to find out where the payload is.
 */

export interface ResponseMeta {
  requestId: string;
  [key: string]: unknown;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T | null;
  error: ApiErrorBody | null;
  meta: ResponseMeta;
}

export function ok<T>(data: T, meta: ResponseMeta): ApiResponse<T> {
  return { success: true, data, error: null, meta };
}

export function fail(error: ApiErrorBody, meta: ResponseMeta): ApiResponse<never> {
  return { success: false, data: null, error, meta };
}
