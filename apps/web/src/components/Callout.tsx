import type { ReactNode } from 'react';

type Tone = 'info' | 'warn' | 'error' | 'success';

interface CalloutProps {
  tone: Tone;
  title: string;
  children?: ReactNode;
  meta?: string;
}

export function Callout({ tone, title, children, meta }: CalloutProps) {
  return (
    <div className={`callout callout--${tone}`}>
      <p className="callout__title">{title}</p>
      {children ? <div>{children}</div> : null}
      {meta ? <p className="callout__meta">{meta}</p> : null}
    </div>
  );
}
