import { useEffect, useState } from 'react';
import { api } from '../api/endpoints';
import { API_BASE_URL } from '../lib/env';

/** Answers "is this actually talking to a server" without opening devtools. */
export function ApiStatusBadge() {
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      api
        .health()
        .then(() => !cancelled && setOnline(true))
        .catch(() => !cancelled && setOnline(false));
    };

    check();
    const timer = window.setInterval(check, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const label = online === null ? 'checking' : online ? 'connected' : 'unreachable';
  const colour =
    online === null
      ? 'var(--colour-chrome-ink-dim)'
      : online
        ? 'var(--colour-free)'
        : 'var(--colour-taken)';

  return (
    <span className="cluster mono" style={{ fontSize: 'var(--text-50)' }}>
      <span
        aria-hidden="true"
        style={{
          width: '7px',
          height: '7px',
          borderRadius: '50%',
          background: colour,
        }}
      />
      <span style={{ color: 'var(--colour-chrome-ink-dim)' }}>
        {API_BASE_URL} · {label}
      </span>
    </span>
  );
}
