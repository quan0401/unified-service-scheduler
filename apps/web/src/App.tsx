import { ApiStatusBadge } from './components/ApiStatusBadge';
import { AppointmentsPage } from './features/appointments/AppointmentsPage';
import { BookingPage } from './features/booking/BookingPage';
import { RacePage } from './features/race/RacePage';
import { ROUTES, ROUTE_LABELS, useHashRoute } from './hooks/useHashRoute';
import { usePersistentState } from './hooks/usePersistentState';
import { DEMO_CUSTOMER_ID } from './lib/env';

export function App() {
  const [route] = useHashRoute();
  const [customerId, setCustomerId] = usePersistentState('scheduler.customerId', DEMO_CUSTOMER_ID);

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__brand">
          <span className="app__brand-name">Service Scheduler</span>
          <span className="app__brand-sub">demo client</span>
        </div>

        <nav className="app__nav" aria-label="Main navigation">
          {ROUTES.map((id) => (
            <a
              key={id}
              className="app__nav-link"
              href={`#/${id}`}
              aria-current={route === id ? 'page' : undefined}
            >
              {ROUTE_LABELS[id]}
            </a>
          ))}
        </nav>

        <ApiStatusBadge />
      </header>

      <main className="app__main">
        {route === 'book' ? (
          <BookingPage customerId={customerId} onCustomerChange={setCustomerId} />
        ) : null}
        {route === 'appointments' ? (
          <AppointmentsPage customerId={customerId} onCustomerChange={setCustomerId} />
        ) : null}
        {route === 'race' ? (
          <RacePage customerId={customerId} onCustomerChange={setCustomerId} />
        ) : null}
      </main>
    </div>
  );
}
