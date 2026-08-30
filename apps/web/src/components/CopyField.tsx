import { useState } from 'react';

/** Mono value plus a copy button, for uuids and idempotency keys. */
export function CopyField({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <span className="copy-field">
      {label ? <span className="muted">{label}</span> : null}
      <span>{value}</span>
      <button type="button" className="btn btn--ghost" onClick={copy}>
        {copied ? 'copied' : 'copy'}
      </button>
    </span>
  );
}
