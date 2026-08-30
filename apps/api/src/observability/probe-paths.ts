/**
 * Paths that carry no diagnostic value.
 *
 * Health probes and metric scrapes are frequent, uniform, and identical to each
 * other. Excluded from both access logging and tracing -- defined once here so
 * the two exclusions cannot drift apart and leave one of them noisy.
 *
 * Deliberately importing nothing: `tracing.ts` reads this before OpenTelemetry
 * has patched anything, and every module loaded at that point is loaded
 * un-instrumented.
 */
export const PROBE_PATHS: readonly string[] = ['/health', '/health/ready', '/metrics'];

export function isProbePath(url: string | undefined): boolean {
  if (!url) return false;
  // Strip any query string: `/metrics?foo=1` is still a scrape.
  const path = url.split('?', 1)[0];
  return PROBE_PATHS.includes(path);
}
