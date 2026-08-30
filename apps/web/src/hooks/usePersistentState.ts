import { useCallback, useState } from 'react';

/** useState backed by localStorage, so a demo survives a reload. */
export function usePersistentState(
  key: string,
  fallback: string,
): [string, (next: string) => void] {
  const [value, setValue] = useState(() => {
    try {
      return window.localStorage.getItem(key) ?? fallback;
    } catch {
      // Private browsing and blocked storage both throw. Not worth failing over.
      return fallback;
    }
  });

  const update = useCallback(
    (next: string) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // Ignored: the in-memory value is still correct for this session.
      }
    },
    [key],
  );

  return [value, update];
}
