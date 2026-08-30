/**
 * Manual spans for the booking path.
 *
 * Auto-instrumentation gives one `pg` span per query, which is enough to see
 * that a request touched the database several times but not enough to say why.
 * A retry storm and a slow query look the same from there. These spans supply
 * the missing structure: attempts are named, numbered, and nested under the
 * request that produced them.
 *
 * Safe to call when tracing is off. With no SDK registered `@opentelemetry/api`
 * hands back a non-recording span, so every method below becomes a no-op and
 * the cost is one object per call. There is deliberately no `if (tracingOn)`
 * guard -- that would be a second, driftable source of truth about a decision
 * `startTracing` already owns.
 */
import { SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('scheduler-booking');

/**
 * Runs `fn` inside a span that is *active* for its duration, so the `pg` spans
 * the callback generates nest underneath rather than scattering at the root.
 *
 * A thrown error is recorded and marks the span failed. That includes
 * "fully booked", which is a legitimate answer rather than a fault -- the
 * `booking.outcome` attribute is what separates the two, and is what an
 * operator should filter on.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      if (error instanceof Error) span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: messageOf(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Adds a timeline marker to whatever span is currently active.
 *
 * Used for events discovered *after* the span that caused them has closed --
 * a lost race is only recognisable once the driver has thrown, by which point
 * the attempt span has ended. The marker lands on the enclosing booking span,
 * where it sits in order alongside the other attempts.
 */
export function annotateActiveSpan(name: string, attributes?: Attributes): void {
  trace.getActiveSpan()?.addEvent(name, attributes);
}

/**
 * Records a fact on the enclosing span as soon as it is known.
 *
 * The attempt count has to be written from inside the retry loop rather than
 * recovered afterwards: an error thrown on the last attempt does not
 * necessarily carry how many there were, and a span that says `attempts: 0`
 * while displaying two attempt children is worse than one that says nothing.
 */
export function setActiveSpanAttributes(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}
