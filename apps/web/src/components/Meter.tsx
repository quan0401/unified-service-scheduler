/** Shows which resource ran out -- technicians or bays -- not just that one did. */
export function Meter({ label, count }: { label: string; count: number }) {
  return (
    <span className="meter" title={`${count} ${label} available`}>
      <span className="meter__label">{label}</span>
      <span className="meter__track">
        <span
          className={`meter__fill${count === 0 ? ' meter__fill--zero' : ''}`}
          style={{ width: `${count === 0 ? 100 : Math.min(100, count * 33.4)}%` }}
        />
      </span>
      <span className="meter__count">{count}</span>
    </span>
  );
}
