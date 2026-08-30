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
        // Health and metrics scrapes would otherwise dominate trace volume.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();

  process.once('SIGTERM', () => {
    void sdk?.shutdown();
  });
}
