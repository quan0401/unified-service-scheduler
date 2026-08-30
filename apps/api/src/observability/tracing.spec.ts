/**
 * The guard nothing had ever checked.
 *
 * `OTEL_EXPORTER_OTLP_ENDPOINT` has been unset in every environment this
 * project runs in -- .env.example, docker-compose, and the test suites -- so
 * the early return is the branch that has executed on every single start. It
 * was also the only branch with no coverage at all.
 */
import { startTracing } from './tracing';

const start = jest.fn();
const NodeSDK = jest.fn().mockImplementation(() => ({ start, shutdown: jest.fn() }));

jest.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: (...args: unknown[]) => NodeSDK(...args),
}));

describe('startTracing', () => {
  const original = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  beforeEach(() => {
    NodeSDK.mockClear();
    start.mockClear();
  });

  afterAll(() => {
    if (original === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = original;
  });

  it('does not start an SDK when no exporter endpoint is configured', () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

    startTracing();

    expect(NodeSDK).not.toHaveBeenCalled();
  });

  it('treats an empty endpoint as unconfigured', () => {
    // Compose expands an unset ${OTEL_EXPORTER_OTLP_ENDPOINT:-} to the empty
    // string rather than removing the variable, so this is the shape the
    // container actually sees when tracing is meant to be off.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = '';

    startTracing();

    expect(NodeSDK).not.toHaveBeenCalled();
  });
});
