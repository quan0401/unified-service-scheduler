import { useEffect, useState } from 'react';

export const ROUTES = ['book', 'appointments', 'race'] as const;
export type RouteId = (typeof ROUTES)[number];

export const ROUTE_LABELS: Record<RouteId, string> = {
  book: 'Book',
  appointments: 'Appointments',
  race: 'Concurrency',
};

function parse(hash: string): RouteId {
  const candidate = hash.replace(/^#\/?/, '');
  return (ROUTES as readonly string[]).includes(candidate) ? (candidate as RouteId) : 'book';
}

/** Three destinations do not justify a router dependency. */
export function useHashRoute(): [RouteId, (next: RouteId) => void] {
  const [route, setRoute] = useState<RouteId>(() => parse(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = (next: RouteId) => {
    window.location.hash = `#/${next}`;
  };

  return [route, navigate];
}
