# @scheduler/web

A small React client for the Unified Service Scheduler API. It exists to make
three things visible that were previously only demonstrable from a terminal:
the booking flow, the persisted confirmation record, and the concurrency
guarantee.

This is a demo client, not a second implemented layer. The backend is the
graded implementation; see the root [`README.md`](../../README.md).

## Run it

```bash
# 1. API with a seeded database (from apps/api)
pnpm prisma migrate deploy && pnpm db:seed && pnpm start:dev

# 2. UI (from the repository root)
pnpm --filter @scheduler/web dev     # http://localhost:5173
```

Or, from the root, `pnpm dev` starts both.

### Pointing at a different API

The browser calls `/api`, which the Vite dev server proxies. Retarget it with
one variable — no `CORS_ORIGIN` change needed:

```bash
# The containerised API, which already runs with raised throttle limits
VITE_API_PROXY_TARGET=http://localhost:13000 pnpm --filter @scheduler/web dev
```

| Variable                | Default                 | Purpose                                                 |
| ----------------------- | ----------------------- | ------------------------------------------------------- |
| `VITE_API_PROXY_TARGET` | `http://localhost:3000` | Where the dev server forwards `/api`                    |
| `VITE_API_BASE_URL`     | `/api`                  | Set to an absolute URL to bypass the proxy and use CORS |
| `VITE_DEMO_CUSTOMER_ID` | —                       | Pre-fills the customer picker                           |

## The three screens

**Book** — dealership, service, vehicle and date, then a slot grid, a hold, and
a confirmation. Each slot shows its technician and bay counts, so when a slot is
unavailable it is obvious _which_ resource ran out. An empty grid means the
dealership is closed that day, which is rendered as its opening-hours table
rather than as "no availability". Times are shown in the dealership's timezone,
never the viewer's.

**Appointments** — list by customer, look up by id, cancel. Cancelling is a
status change, so the record stays and re-renders as `CANCELLED`. There is no
optimistic update: the server is the authority.

**Concurrency** — fires N bookings at one slot and buckets the outcomes. See
below.

## Why a proxy rather than CORS

The API is already configured for a Vite client (`CORS_ORIGIN` is
`http://localhost:5173`), so direct cross-origin calls work. The proxy is still
the default for two reasons:

- A JSON `POST` is never a CORS-simple request, so cross-origin every booking is
  preceded by an `OPTIONS` preflight. N requests fired in one tick cannot share a
  cached preflight, which doubles the round trips in exactly the screen where
  request timing is the point.
- `main.ts` sets no `exposedHeaders`, so `X-Request-Id` is unreadable to
  cross-origin JavaScript. Same-origin, the header round-trips.

Either way the client reads the correlation id from `meta.requestId` in the body,
which is always available.

## What the concurrency screen does and does not prove

Measured against the seeded data, N=50, default throttle:

```
1 × 201 created · 19 × 409 SLOT_UNAVAILABLE · 0 × 409 SLOT_CONTENDED
30 × 429 rate limited · server holds exactly 1 CONFIRMED row
```

Three caveats, stated in the UI as well as here:

1. **Losers report `SLOT_UNAVAILABLE`, not `SLOT_CONTENDED`.** The winner commits
   fast enough that the others' availability filter already sees the slot taken.
   `SLOT_CONTENDED` means all three server-side attempts hit the exclusion
   constraint; it stays at zero, and that is the point — the constraint is the
   backstop for the genuinely simultaneous window, not the everyday path.
2. **Browsers cap concurrent connections per origin** at roughly six over
   HTTP/1.1, so these requests leave in waves rather than all at once. The
   dispatch timeline renders that stair-step rather than hiding it. The
   genuinely parallel proof, at 200 requests with database-level assertions,
   remains `apps/api/test/concurrency/booking-race.e2e-spec.ts`.
3. **429s are the rate limiter, not the constraint.** They are bucketed and
   labelled separately, because collapsing them into the conflict count would
   overstate what the demo shows.

The headline count is taken by querying the API after the run, not by adding up
the tiles — the tiles illustrate, the query asserts.

## Dependencies, and what is deliberately absent

`react`, `react-dom`, `vite`, and `@scheduler/contracts`. That is the whole
runtime list.

- **No date library.** The client never constructs an instant: `startAt` is
  copied verbatim from the availability response, and the date parameter comes
  straight out of `<input type="date">`. The only need is rendering a UTC instant
  in an IANA zone, which is one `Intl.DateTimeFormat`.
- **No router.** Three destinations and a 25-line hash hook.
- **No state library.** Five GET resources, none shared between screens, and a
  small `useResource` hook that deliberately does not cache — silently serving a
  stale slot grid would undercut the thing this app exists to show.
- **No CSS framework.** Design tokens in `src/styles/tokens.css`.

`@scheduler/contracts` is resolved to its _source_ rather than its build output,
matching the precedent in `apps/api/jest.config.js`, so a stale `dist` can never
make types and runtime disagree. `createHoldSchema` validates the form before
submit, so the browser and the server enforce one declaration.

## Tests

```bash
pnpm --filter @scheduler/web test
```

Three specs, all pure functions, no jsdom and no component tests:

- `features/race/raceBuckets.test.ts` — the outcome classifier. It asserts that a
  429 buckets as throttled despite carrying the generic `TOO_MANY_REQUESTS` code,
  and that the two 409s stay distinct. This is the demo's claim expressed as a
  function, and where a wrong answer would be invisible on screen.
- `lib/format.test.ts` — the timezone rendering. The app's only timezone logic,
  and the one bug that would look right and be wrong.
- `api/messages.test.ts` — error-copy fallback. Exhaustiveness over
  `DomainErrorCode` is already a compile error via a mapped type, so only the
  unknown-code path needs a runtime assertion.

Component tests would exercise React rather than the domain; the business logic
they would touch is already covered by the API's unit, integration, and
concurrency suites.
