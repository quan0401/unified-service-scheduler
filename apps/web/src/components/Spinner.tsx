export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="cluster muted">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
