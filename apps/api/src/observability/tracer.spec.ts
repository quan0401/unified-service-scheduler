/**
 * `withSpan` wraps the booking path, so its one hard requirement is that it
 * changes nothing: same return value, same thrown error, same control flow.
 * A tracing helper that swallowed an exception would turn a lost race into a
 * silent success.
 *
 * These run against the no-op tracer -- no SDK is registered under test, which
 * is also how the service runs whenever tracing is off.
 */
import { annotateActiveSpan, withSpan } from './tracer';

describe('withSpan', () => {
  it('returns the callback result unchanged', async () => {
    await expect(withSpan('test.ok', { a: 1 }, async () => 'value')).resolves.toBe('value');
  });

  it('rethrows the original error instance', async () => {
    const failure = new Error('lost the race');

    await expect(
      withSpan('test.throw', {}, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it('passes a span the caller can annotate', async () => {
    const seen = await withSpan('test.span', {}, async (span) => {
      span.setAttribute('booking.outcome', 'confirmed');
      return typeof span.setAttribute;
    });

    expect(seen).toBe('function');
  });

  it('propagates a non-Error rejection', async () => {
    await expect(
      withSpan('test.reject', {}, async () => {
        throw 'a string';
      }),
    ).rejects.toBe('a string');
  });
});

describe('annotateActiveSpan', () => {
  it('is a no-op with no active span', () => {
    expect(() => annotateActiveSpan('booking.race_lost', { n: 1 })).not.toThrow();
  });

  it('records an event on the enclosing span', async () => {
    await expect(
      withSpan('test.parent', {}, async () => {
        annotateActiveSpan('booking.race_lost', { 'booking.attempt_number': 2 });
        return 'done';
      }),
    ).resolves.toBe('done');
  });
});
