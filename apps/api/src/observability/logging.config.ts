/**
 * Structured logging configuration.
 *
 * JSON in every environment except local development, where a human is reading
 * the terminal. Correlation IDs are attached per request so a single booking --
 * including its retries -- can be reconstructed from the log stream.
 */
import type { Params } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

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
        return id;
      },

      // Scrapes and probes are high-frequency and carry no diagnostic value.
      autoLogging: {
        ignore: (request: IncomingMessage) =>
          request.url === '/metrics' ||
          request.url === '/health' ||
          request.url === '/health/ready',
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
