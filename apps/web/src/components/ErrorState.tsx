import type { ApiError } from '../api/ApiError';
import { copyFor } from '../api/messages';
import { Button } from './Button';
import { Callout } from './Callout';

interface ErrorStateProps {
  error: ApiError;
  onRetry?: () => void;
}

/**
 * Renders an ApiError through its code rather than its prose, so the UI branches
 * on the same machine-readable signal the API was designed to expose.
 */
export function ErrorState({ error, onRetry }: ErrorStateProps) {
  const copy = copyFor(error);

  return (
    <Callout
      tone={error.status === 429 ? 'warn' : 'error'}
      title={copy.title}
      meta={`${error.code}${error.status ? ` · HTTP ${error.status}` : ''} · request ${error.requestId}`}
    >
      <p>{copy.body}</p>
      {copy.recovery && onRetry ? (
        <p style={{ marginTop: 'var(--space-2)' }}>
          <Button variant="secondary" onClick={onRetry}>
            {copy.recovery}
          </Button>
        </p>
      ) : null}
    </Callout>
  );
}
