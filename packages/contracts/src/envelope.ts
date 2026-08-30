/**
 * Uniform response envelope.
 *
 * Every response -- success or failure -- has the same top-level shape, so a
 * client never has to branch on status code to find out where the payload is.
 *
 * Only the types live here. The `ok()` / `fail()` constructors stay in the
 * server: a client reads an envelope, it never builds one.
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
