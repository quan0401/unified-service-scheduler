/**
 * Build-time configuration. Vite inlines `import.meta.env` at build, so these
 * are constants by the time the browser sees them.
 */

/**
 * Default `/api` routes through the dev-server proxy, which keeps the app
 * same-origin. That matters for two reasons documented in vite.config.ts: a
 * JSON POST is never a CORS-simple request, so cross-origin every booking pays
 * an OPTIONS preflight; and the API sets no `exposedHeaders`, so `X-Request-Id`
 * is unreadable cross-origin.
 */
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api';

export const DEMO_CUSTOMER_ID = import.meta.env.VITE_DEMO_CUSTOMER_ID ?? '';
