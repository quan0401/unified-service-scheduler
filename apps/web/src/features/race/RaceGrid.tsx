import type { RaceAttempt } from './useRaceRunner';

export function RaceGrid({ attempts }: { attempts: readonly RaceAttempt[] }) {
  return (
    <ul className="race-grid">
      {attempts.map((attempt) => (
        <li
          key={attempt.index}
          className={`race-tile race-tile--${attempt.bucket}`}
          title={attempt.code ?? 'created'}
        >
          #{attempt.index}
          <br />
          {attempt.status}
        </li>
      ))}
    </ul>
  );
}
