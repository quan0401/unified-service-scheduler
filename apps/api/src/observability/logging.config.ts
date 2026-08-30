/**
 * Structured logging configuration.
 *
 * JSON in every environment except local development, where a human is reading
 * the terminal. Correlation IDs are attached per request so a single booking --
 * including its retries -- can be reconstructed from the log stream.
 */
import { trace } from '@opentelemetry/api';
import type { Params } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isProbePath } from './probe-paths';

const REQUEST_ID_HEADER = 'x-request-id';

export function loggingConfig(): Params {
  const isDevelopment = process.env.NODE_ENV !== 'production';

  return {
    pinoHttp: {
      level: process.env.LOG_LEVEL ?? (isDevelopment ? 'debug' : 'info'),

      // Honour an upstream id so a trace begun at the edge stays continuous.
      genReqId: (request: IncomingMessage, response: ServerResponse) => {
        const inbound = request.headers[REQUEST_ID_HEADER];
        const id = typeof inbound === 'string' && inbound ? inbound : randomUUID();
        response.setHeader(REQUEST_ID_HEADER, id);

        // Close the loop between the two correlation schemes. Pino records
        // already carry trace_id (injected by instrumentation-pino), which
        // gets you from a log line to its trace; this gets you back the other
        // way, from a trace to the log lines that describe it. A no-op when
        // tracing is off.
        trace.getActiveSpan()?.setAttribute('app.request_id', id);
        return id;
      },

      // Scrapes and probes are high-frequency and carry no diagnostic value.
      // The same list excludes them from tracing -- see probe-paths.ts.
      autoLogging: {
        ignore: (request: IncomingMessage) => isProbePath(request.url),
      },

      // Never log credentials or client identifiers verbatim.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["idempotency-key"]',
        ],
        remove: true,
      },

      transport: isDevelopment
        ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss' } }
        : undefined,
    },
  };
}
