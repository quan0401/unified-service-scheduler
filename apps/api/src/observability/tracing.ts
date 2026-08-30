/**
 * OpenTelemetry bootstrap.
 *
 * Imported before anything else in `main.ts` so auto-instrumentation can patch
 * http and pg before those modules are loaded -- patching after the fact
 * silently produces no spans, which looks identical to "tracing is off".
 *
 * Tracing earns its place on the booking path specifically. A retry storm is
 * invisible in logs (each attempt looks like an ordinary query) but obvious as
 * a trace: one request span containing several database spans, the earlier ones
 * ending in a constraint rejection.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { isProbePath } from './probe-paths';

let sdk: NodeSDK | undefined;

export function startTracing(): void {
  // Off unless an endpoint is configured: exporting to nowhere adds latency and
  // noisy connection errors in local development and CI.
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'scheduler-api',
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '1.0.0',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Filesystem spans are extremely high volume and say nothing about a
        // service whose interesting work is SQL. They bury the booking path.
        '@opentelemetry/instrumentation-fs': { enabled: false },

        // Health probes and metric scrapes would otherwise dominate trace
        // volume. Filtered against the same list logging.config.ts uses, so an
        // endpoint cannot end up excluded from logs but present in traces.
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (request) => isProbePath(request.url),
        },

        // Left enabled deliberately: it injects trace_id and span_id into every
        // pino record, which is the only reason a log line can be traced back
        // to its request. It works because startTracing() runs before
        // nestjs-pino is required -- see the note above.
        '@opentelemetry/instrumentation-pino': { enabled: true },
      }),
    ],
  });

  sdk.start();

  process.once('SIGTERM', () => {
    void sdk?.shutdown();
  });
}
