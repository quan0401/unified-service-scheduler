# Unified Service Scheduler

A dealership service-appointment booking API. Replaces manual booking while
preserving the one guarantee the manual system had for free: **a bay and a
technician cannot be double-booked.**

Scenario A (Ownership). Backend implemented; the client layer is stubbed with an
OpenAPI document, a cURL walkthrough, and a REST Client file, as the brief
allows.

| Artifact | Where |
|---|---|
| System Design Document | [`DESIGN.md`](DESIGN.md) |
| API contract | [`apps/api/docs/openapi.json`](apps/api/docs/openapi.json), Swagger UI at `/docs` |
| Client stub / test harness | [`apps/api/docs/curl-walkthrough.md`](apps/api/docs/curl-walkthrough.md), [`apps/api/docs/booking-flow.http`](apps/api/docs/booking-flow.http) |
| AI collaboration narrative | [§ below](#ai-collaboration-narrative) · raw log: [`docs/ai-collaboration-log.md`](docs/ai-collaboration-log.md) |

---

## The problem in one paragraph

The brief's second requirement — *"before confirming, check for the availability
of both a ServiceBay and a qualified Technician for the entire service
duration"* — is a check-then-act race. Two requests both read "Ramp A is free at
09:00", both pass their check, and both insert. No amount of application-level
checking closes that window, because only the database sees both writes. So the
guarantee lives in **PostgreSQL GiST exclusion constraints**, which make an
overlapping row impossible to write, and the application's job is to lose that
race rarely and cleanly. Full reasoning in [`DESIGN.md`](DESIGN.md).

---

## Prerequisites

- **Node.js 22+** and **pnpm 10+**
- **PostgreSQL 16** with the `btree_gist` extension available

`btree_gist` ships with standard PostgreSQL distributions (Postgres.app,
Homebrew, the official Docker image, most managed providers). Verify:

```sql
SELECT default_version FROM pg_available_extensions WHERE name = 'btree_gist';
```

If you prefer Docker, `docker compose up -d` starts a suitable PostgreSQL 16 on
port 5432. It is optional — any PostgreSQL 16 works.

---

## Workspace

A pnpm workspace driven by Turborepo. Two packages, and the split is narrow on
purpose:

```text
apps/api/              the NestJS modular monolith
  src/modules/         appointments · availability · catalog · background-jobs
  src/common/          envelope, exception filter, request context, errors
  src/observability/   metrics, tracing, logging
  src/prisma/          client lifecycle
  prisma/              schema, migrations, seed
  docs/                OpenAPI document and client stubs
packages/contracts/    request schemas, response types, error codes
```

`@scheduler/contracts` exists because the brief has the client *stubbed* rather
than built, and a stub that restates the request shape in its own words drifts
from the server silently. Sharing one Zod declaration makes that drift a
compile error. It exports plain Zod and depends only on `zod` — no NestJS, no
database client — so a browser can consume it.

Nothing else is extracted. Prisma, the domain errors, and the slot generator
each have exactly one consumer, and splitting them would add import boundaries
without adding seams.

---

## Build and run

```bash
pnpm install          # at the repository root — it is a workspace

cd apps/api
cp .env.example .env
# Edit DATABASE_URL and TEST_DATABASE_URL for your PostgreSQL.
# Postgres.app / local socket auth typically needs your OS username:
#   DATABASE_URL="postgresql://$USER@localhost:5432/scheduler?schema=public"

createdb scheduler && createdb scheduler_test   # or via docker compose

pnpm prisma migrate deploy   # creates tables AND the exclusion constraints
pnpm db:seed                 # prints the ids used in the walkthrough
pnpm start:dev
```

The API listens on `http://localhost:3000`. Swagger UI is at `/docs`.

> **`migrate deploy`, not `db push`.** The exclusion constraints exist only in
> hand-written migration SQL — Prisma's schema language cannot express them.
> Pushing the schema alone creates tables with no constraints, and every
> concurrency test would then pass vacuously.

## Test

From the repository root:

```bash
pnpm build             # builds contracts, then the API
pnpm test              # unit — pure logic, no database
```

The database-backed suites are run against the API package directly, because
they need `apps/api/.env`:

```bash
cd apps/api
pnpm test:integration  # integration + concurrency — needs PostgreSQL
pnpm test:load         # the 200-way race on its own
pnpm test:cov          # combined coverage
```

Turbo caches `build` and `test`. The database-backed tasks are declared
`"cache": false` — their result depends on live database state rather than on
file inputs, so a cached "pass" could report success for a suite that never ran
against the current schema.

**74 tests. 93.0% statements, 94.2% lines, 96.9% functions.**

| Suite | Tests | What it proves |
|---|---|---|
| `slot-generator.spec.ts` | 16 | DST transitions, closed days, closing-time overrun, foreign timezones |
| `exclusion-constraints.e2e-spec.ts` | 12 | The database rejects overlaps — written *before* any service code |
| `booking.e2e-spec.ts` | 20 | Booking, refusals, holds, idempotency, cancellation |
| `availability.e2e-spec.ts` | 10 | Occupancy reflects skills, capabilities, shifts, bookings |
| `catalog-and-jobs.e2e-spec.ts` | 11 | Reference data, health, metrics format, outbox, sweeper |
| `booking-race.e2e-spec.ts` | 5 | **The decisive tests** |

The decisive one fires **200 simultaneous bookings at a single slot backed by a
single bay** and asserts exactly one `201`, 199 `409`, and exactly one row in
the table. A sequential test would prove nothing: the naive implementation this
design exists to avoid passes every sequential test and fails the moment two
customers click at once.

## Try it by hand

[`apps/api/docs/curl-walkthrough.md`](apps/api/docs/curl-walkthrough.md) walks the whole
flow — availability, hold, confirm, idempotent replay, every refusal path,
cancel-and-rebook, and a 50-request concurrency demo. Every command in it was
executed and its output verified.

---

## API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/dealerships` | With timezone and opening hours |
| `GET` | `/service-types` | With durations |
| `GET` | `/customers/:id/vehicles` | 404 for unknown customer, not an empty list |
| `GET` | `/availability` | Slot grid. **Advisory** — booking re-checks atomically |
| `POST` | `/holds` | Reserve a slot for 2 minutes |
| `POST` | `/appointments` | Confirm. Accepts `holdId` and `Idempotency-Key` |
| `GET` | `/appointments/:id` | Confirmation record |
| `GET` | `/appointments?customerId=` | List |
| `DELETE` | `/appointments/:id` | Cancel; frees the slot, keeps the record |
| `GET` | `/health`, `/health/ready` | Liveness, readiness |
| `GET` | `/metrics` | Prometheus |

Every response shares one envelope:

```json
{ "success": true, "data": {}, "error": null, "meta": { "requestId": "…" } }
```

Errors carry a machine-readable code so clients branch without parsing prose:
`VEHICLE_NOT_OWNED` (403), `OUTSIDE_OPENING_HOURS` (422), `SLOT_UNAVAILABLE`
(409, genuinely full), `SLOT_CONTENDED` (409, lost every retry),
`HOLD_EXPIRED` (409).

The last two are distinguished deliberately: collapsing them would erase the
only signal separating "busy dealership" from "system fighting itself".

### Note on authentication

There is none — the brief does not ask for it, and building a login system would
spend effort outside the graded requirements. The one ownership rule the domain
*implies* is enforced server-side: an appointment associates a customer and
*their* vehicle, so booking someone else's car returns 403. A `@CurrentCustomer()`
decorator marks where a real guard would attach.

Consequences, stated rather than hidden: the API is IDOR-able, and rate limiting
is per-IP rather than per-customer.

---

## AI Collaboration Narrative

The raw, unedited log is [`docs/ai-collaboration-log.md`](docs/ai-collaboration-log.md) —
eleven entries written as things happened. This is the summary.

### Strategy: generate fast, then attack

The value was never in the first answer. It was in getting something concrete
enough to be **wrong in an identifiable way**. AI is excellent at producing a
plausible, conventional, complete-looking design in seconds; that design is a
starting position to argue with, not a result.

Concretely, this meant three rules:

1. **Ask mechanical questions, not stylistic ones.** Not "is this good code?"
   but "what does this lock actually lock?"
2. **Never accept a correctness claim that was not executed.** Every load-bearing
   claim in `DESIGN.md` is backed by something that ran.
3. **Treat a green test that confirms the hypothesis as suspicious**, not as
   confirmation.

### What that caught — the central example

The first concurrency design used `SELECT … FOR UPDATE` on the technician and
bay rows, with a database constraint as a backstop. It is textbook, it is what
most engineers would write, and it would have shipped.

It is also wrong. A row lock locks the **resource**, not the **time slot** — a
09:00 booking blocks an unrelated 15:00 booking for the same technician. At a
busy dealership that degenerates into a hot-row queue: correct, and serialised.
The failure mode is invisible in a demo and severe in production.

What caught it was asking what the lock physically locks. That reframed the
exclusion constraint from *backstop* to *authority*, and pessimistic locking was
removed entirely rather than supplemented.

A related correction: `ORDER BY least_loaded` looks obviously right for choosing
among free technicians. Reasoning about what N simultaneous requests each
compute shows it makes every request target the same technician, so N−1 collide
— the fairness heuristic manufactures the contention it appears to relieve.
`ORDER BY random()` looks wrong and is correct. It is commented as such, because
a future reader will otherwise "fix" it.

### The same instinct, applied to structure

Asked to restructure this into a Turborepo monorepo, the first plan produced
five packages and a placeholder web app. Every package came with a plausible
rationale attached — which is the failure mode above in a different costume.
Three were two-file extractions, and the web app existed mainly to justify the
monorepo, which was then justified by pointing at the web app.

Reframing the question from *"what could be extracted?"* to *"what would each
extraction prevent?"* left one package standing. `@scheduler/contracts` prevents
something real: the brief has the client stubbed, so a stub restating the
request shape in its own words drifts from the server with nothing to catch it.
The rest prevented nothing, and would have cost a restructure of documentation
that was currently accurate.

Worth naming because it is the harder direction. The model's structural instinct
is additive, and it argues well for each piece in isolation; plausible-per-item
is not the same as justified as a set.

### Verification process — three findings that only execution produced

None of these would have survived a reading-based review.

**A DST bug, caught by tests written first.** The slot generator treated opening
hours as elapsed minutes from local midnight. It passed every ordinary test.
Two daylight-saving tests failed: a 23-hour day produced 24 slots. Opening hours
are *wall-clock* times ("we close at 18:00 local"), not elapsed durations — the
two coincide on 363 days a year. As written, the dealership would have opened an
hour late every spring. No reviewer would flag that line.

**An expired-hold constraint gap, caught by an *intermittent* failure.** One
test passed under `test:integration` and failed under the coverage run — the
kind of thing usually dismissed as flakiness and re-run. It was a real defect: a
PostgreSQL exclusion predicate must be `IMMUTABLE`, so it cannot call `now()`.
An expired hold therefore still occupies the slot at the constraint level while
appearing free to every query — the slot advertises itself as bookable and
rejects every booking. Worse, the `ORDER BY random()` added to reduce contention
was *masking* it by routing around the broken resource. Fixed by reclaiming
lapsed holds on conflict; the test was rewritten with a single technician and
bay so it now fails deterministically.

**A test that might have been passing vacuously.** The concurrency suite went
green on its first run with exactly the hoped-for result — which is precisely
when a test deserves the most scrutiny. An independent standalone script
reported the opposite: 200 × HTTP 500, zero rows. Chasing down which one lied
found the *script* was at fault (`tsx` compiles with esbuild, which does not
emit `emitDecoratorMetadata`, so NestJS DI failed before any business logic
ran). Instrumenting inside Jest confirmed the real distribution and produced a
genuine insight: losers report `SLOT_UNAVAILABLE`, not `SLOT_CONTENDED`, because
the winner commits fast enough that their availability filter already sees the
slot taken. The exclusion constraint is the backstop for the genuinely
simultaneous window, not the everyday path — inferred beforehand, measured
afterwards.

### Scope discipline

An early pass added JWT auth, login, and role-based access. Re-reading the brief
showed "Domain: Ownership" names the *business domain* — vehicle ownership, the
post-sale product area — not an access-control requirement. The model had
pattern-matched "production API" and supplied the usual furniture. Cut to the
single ownership rule the domain implies, with a documented seam and the
consequences named.

A second instance: the original plan built a React UI *and* the backend. The
brief says implement one layer and stub the other. The UI was dropped and the
effort moved to the graded artifacts.

### Where AI was strong and weak

**Strong:** breadth and speed. The Prisma schema, SQL skeleton, test scaffolding,
seed data, and the plausible-but-wrong first design all arrived in minutes and
were worth having — including the wrong one, which was the most useful thing it
produced.

**Weak:** exactly where correctness mattered most.

- **Concurrency semantics** — the initial locking design was confidently wrong.
- **Timezone arithmetic** — the wall-clock/elapsed distinction was silently
  glossed over.
- **Third-party library behaviour** — an assertion checked for Prisma error code
  `P2010`; Prisma actually surfaces the same SQLSTATE two different ways
  depending on whether the query was raw or typed, with the code buried in
  Rust-debug-escaped message text. That fix became shared production code
  (`src/common/postgres-errors.ts`), not a test workaround, because the booking
  path needs the same detection.
- **API drift** — several suggested APIs did not exist in the installed
  versions: `patchNestJsSwagger` (removed in `nestjs-zod` v5, now
  `cleanupOpenApiDoc`), and `@nestjs/swagger` v12 being ESM-only against a
  CommonJS build.

### Ownership

Every architectural decision here has a stated reason, and every reason is
either mechanical (what the lock locks, what the constraint predicate can
evaluate) or measured (74 tests, 258 ms for 200 concurrent bookings, a verified
status distribution). Where a decision has a cost — Prisma with PgBouncer
disabling prepared statements, no authentication, at-least-once event delivery —
it is named in `DESIGN.md` rather than left for a reader to discover.

Two guardrails also came from tools rather than judgement, and both were right:
Prisma refused to run `migrate reset` under an AI agent because it is
destructive, which prompted switching the test setup to the non-destructive
`migrate deploy` plus a `TEST_DATABASE_URL` safety check — removing the need for
the dangerous command entirely rather than asking permission to run it.

---

## Full tree

```text
DESIGN.md                     System Design Document (Part 1)
docs/ai-collaboration-log.md  Raw decision log
docker-compose.yml            Optional PostgreSQL 16
turbo.json                    Task graph; DB-backed tasks are uncached
tsconfig.base.json            One compiler baseline for every package

packages/contracts/
  src/schemas.ts     Zod request schemas — plain Zod, no NestJS
  src/envelope.ts    ApiResponse<T>, ApiErrorBody, ResponseMeta
  src/views.ts       Availability response shapes
  src/errors.ts      DomainErrorCode union

apps/api/
  src/
    modules/
      appointments/     booking (atomic claim statement), holds, cancel
      availability/     slot generator (pure) + occupancy query
      catalog/          reference data
      background-jobs/  outbox relay, hold expiry sweeper
    common/          envelope constructors, domain errors, filter, request context
    observability/   metrics, logging, tracing, health
    prisma/          client lifecycle, session timeouts
  prisma/
    schema.prisma
    migrations/      includes the hand-written exclusion constraints
    seed.ts
  test/
    integration/     constraints, booking, availability, catalog + jobs
    concurrency/     the decisive race tests
  docs/              openapi.json, curl-walkthrough.md, booking-flow.http
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection |
| `TEST_DATABASE_URL` | — | Integration database; must contain `scheduler_test` |
| `PORT` | `3000` | HTTP port |
| `HOLD_TTL_SECONDS` | `120` | Reservation lifetime |
| `DB_LOCK_TIMEOUT_MS` | `2000` | Fail fast rather than queue |
| `DB_STATEMENT_TIMEOUT_MS` | `5000` | Fail fast rather than queue |
| `THROTTLE_BURST_LIMIT` | `20` | Per-IP, per second |
| `THROTTLE_SUSTAINED_LIMIT` | `300` | Per-IP, per minute |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Tracing is inert unless set |
| `LOG_LEVEL` | `debug` / `info` | pino level |

The throttle limits are environment-driven because load testing drives hundreds
of requests from a single address, which is indistinguishable from abuse at
production thresholds.
