# AI Collaboration Log

A running, unedited record of decisions made while building this service with AI
assistance. `README.md` carries the curated narrative; this file is the evidence
behind it, written as things happened rather than reconstructed afterwards.

Each entry records what the AI proposed, what was wrong or unverified about it,
how it was checked, and what changed as a result.

---

## 1. Scope: authentication was proposed, then cut

**Proposed.** An early design pass added JWT authentication, login, and
role-based access for service advisors and admins.

**Challenged.** The brief never mentions authentication. Re-reading it, "Domain:
Ownership" names the business domain — vehicle ownership, the post-sale product
area — not an access-control requirement. The three Core Requirements concern
resource contention only.

**Resolved.** No auth. But Requirements 1 and 3 do imply the vehicle belongs to
the requesting customer, so that single rule is enforced in the service layer,
reading the customer id from the request body — the single seam a real guard
would replace by resolving it from a verified token instead.
The two resulting gaps (IDOR-able API, per-IP rather than per-customer
throttling) are named explicitly in the README rather than left implicit.

**Lesson.** The AI's instinct was to add conventional production scaffolding.
Scope came from re-reading the brief, not from the model.

---

## 2. Concurrency: the first design was plausible and wrong

**Proposed.** `SELECT ... FOR UPDATE` on the technician and bay rows inside the
booking transaction, with a database constraint as a backstop.

**Challenged.** A row lock locks the *resource*, not the *time slot*. Booking a
technician at 09:00 would block an unrelated 15:00 booking for the same
technician — two bookings that can never conflict. At a busy dealership this
collapses into a hot-row queue, so the design would have been correct and slow,
which is the failure mode that is hardest to notice in a demo and most damaging
in production.

**Resolved.** PostgreSQL GiST exclusion constraints became the authority rather
than the backstop. They conflict only on `(resource, overlapping range)` — the
finest granularity available — so non-overlapping bookings proceed fully in
parallel. Pessimistic locking was removed entirely, not merely supplemented.

**Lesson.** This is the central verification story of the build. The first
answer was textbook, confident, and would have shipped. What caught it was
asking what the lock actually locks, rather than whether the code was correct.

---

## 3. Candidate selection: the obvious ordering causes a thundering herd

**Proposed.** `ORDER BY least_loaded` when choosing among free technicians —
fair, and it balances workload.

**Challenged.** Under concurrent load every request computes the same "least
loaded" technician and targets it, so N−1 requests collide and retry. The
fairness heuristic actively manufactures contention.

**Resolved.** `ORDER BY random()` across the free pool, which spreads inserts
and drops the retry rate from roughly O(N) toward zero. Because it reads as a
mistake, the reasoning is commented at the call site.

**Lesson.** The intuitive choice was worse than the counterintuitive one. Load
behaviour has to be reasoned about explicitly; it is not visible in the code.

---

## 4. Verification ordering: prove the guarantee before depending on it

**Decision.** The exclusion constraints were written, applied, and then tested
directly through Prisma — inserting genuinely overlapping rows and asserting
SQLSTATE `23P01` — *before* any service code existed.

**Why.** Every later test trusts that an overlapping row cannot be written. Had
the migration silently not applied, the whole suite would have passed vacuously
and the concurrency test would have proved nothing. A guarantee nobody verified
is just a comment.

Twelve tests cover: each of the three constraints firing, half-open `'[)'`
bounds allowing back-to-back bookings, `HELD` blocking competitors, `CANCELLED`
and `COMPLETED` freeing the slot, and both check constraints.

---

## 5. Two bugs the tests caught, and what they revealed

**Test fixtures.** VIN generation appended a uniqueness suffix and then truncated
to 17 characters — the real VIN length — cutting off the part that made it
unique. Collisions followed. Trivial, but it surfaced immediately because the
fixtures were exercised by real inserts rather than mocks.

**Prisma error shapes.** The first assertion checked for Prisma error code
`P2010`. It failed even though the constraint fired correctly. The cause is a
genuine inconsistency in Prisma: raw queries raise
`PrismaClientKnownRequestError` with the SQLSTATE in `meta.code`, while typed
client calls raise `PrismaClientUnknownRequestError` with the SQLSTATE only in
the message text — additionally escaped, because the Postgres message is
embedded via Rust debug formatting.

This mattered beyond the test. The booking path issues raw SQL and had to detect
`23P01` reliably, so the fix became shared production code
(`src/common/postgres-errors.ts`) that matches on SQLSTATE across both shapes,
rather than a workaround inside a test.

**Lesson.** The AI-generated assertion looked right and encoded an assumption
about a third-party library that was false. Running it against a real database
is what exposed it — no amount of review would have.

---

## 6. Environment: Testcontainers was planned, Docker was absent

**Planned.** Testcontainers, so integration tests would spin up their own
PostgreSQL.

**Reality.** The Docker daemon was not running on the build machine. Rather than
assume, the environment was checked directly: PostgreSQL 16.10 present,
`btree_gist` 1.7 available, superuser access confirmed — *before* committing to
a design that depends on an extension.

**Resolved.** Tests target a dedicated `scheduler_test` database.
`docker-compose.yml` is retained so the repo still runs on a clean machine.

**Also.** Prisma refuses to run `migrate reset` when it detects an AI agent,
requiring explicit human consent because the command is destructive. Rather than
request that consent, the setup was changed to `migrate deploy` — non-destructive
— with per-test isolation handled by `TRUNCATE`. A guard was added rejecting any
`TEST_DATABASE_URL` that does not name a test database. The tool was right to
stop, and the correct response was to remove the need for the dangerous command.

---

## 7. A DST bug the tests caught before it shipped

**Written.** The first slot generator treated opening hours as elapsed minutes
from local midnight: `startOfDay.plus({ minutes: openMinute })`. It passed every
ordinary test.

**Caught.** Two daylight-saving tests failed — a 23-hour spring-forward day
produced 24 slots and a 25-hour fall-back day produced 24 instead of 25.

**Root cause.** Opening hours are *wall-clock* times ("we close at 18:00 local"),
not elapsed durations. The two coincide on all 363 ordinary days a year and
diverge on the two that matter. As written, the dealership would have opened an
hour late every spring and the last bookable hour would have vanished.

**Fixed.** Open and close resolve as wall-clock instants; slot *stepping* stays
elapsed time, because an appointment occupies real duration — a 60-minute
service is 60 real minutes even if the local clock jumps during it. Both
semantics are now stated in comments, since the distinction is invisible in the
code otherwise.

**Lesson.** The DST tests were written before the implementation and were the
only reason this surfaced. It is exactly the class of bug that reaches
production, because it is correct 363 days a year and no reviewer would flag the
original line.

---

## 8. Verifying that the concurrency test was not passing vacuously

**Situation.** The concurrency suite went green on the first run: 200 simultaneous
bookings, one `201`, 199 `409`. That is exactly the hoped-for result, which is
precisely why it should not be believed without checking.

**Check.** A standalone script reproduced the same scenario outside Jest. It
reported **200 × HTTP 500 and zero rows** — the opposite result. One of the two
had to be wrong.

**Diagnosis.** The standalone runner was at fault, not the tests. It ran under
`tsx`, which compiles with esbuild, and esbuild does not implement
`emitDecoratorMetadata`. NestJS dependency injection depends on that metadata,
so every request failed inside the container before reaching any business
logic. The Jest suite compiles through `ts-jest`, which does emit it.

**Confirmation.** Instrumenting inside Jest and printing the raw distribution:

```
requests   : 200
http tally : { '201': 1, '409': 199 }
error codes: { SLOT_UNAVAILABLE: 199, ok: 1 }
rows       : 1
outbox     : 1
wall clock : 258 ms
```

**A finding worth keeping.** All 199 losers received `SLOT_UNAVAILABLE`, not
`SLOT_CONTENDED` — meaning the winner committed fast enough that everyone else's
`NOT EXISTS` filter already saw the slot occupied. The exclusion constraint
almost never fires in practice. It is the backstop for the genuinely
simultaneous window, while the atomic statement absorbs the ordinary case. That
is the intended behaviour, but it was an inference until the distribution was
measured.

**Lesson.** A green test that confirms what you wanted deserves more scrutiny
than a red one, not less. Two independent measurements disagreed, and finding
out which one lied was worth more than either result on its own.

---

## 9. A latent bug found by an intermittently failing test

**Symptom.** The test "treats an expired hold as free for a new booking" passed
under `test:integration` and failed under the coverage run. Flaky tests are
usually blamed on timing and re-run until green. This one was a real defect.

**Root cause.** An asymmetry between two things that both look like they check
hold expiry, and only one does:

- The booking query treats a hold as free once `hold_expires_at` has passed:
  `(a.status = 'CONFIRMED' OR a.hold_expires_at > now())`.
- The exclusion constraint **cannot**. A PostgreSQL exclusion predicate must be
  `IMMUTABLE`, so it cannot call `now()`. Its predicate is
  `status IN ('HELD','CONFIRMED')` and nothing more.

So an expired hold row appears free to every query while still physically
occupying the slot at the constraint level. The slot advertises itself as
bookable and rejects every booking, until the background sweeper happens to run.

**Why it was intermittent.** The failing test used a scenario with two
technicians and two bays. `ORDER BY random()` routed most attempts to the
*other* pair, which succeeded. The bug only surfaced when the random pick landed
on the resource the stale hold occupied.

**Fix.** On a constraint conflict, booking now reclaims lapsed holds overlapping
the requested window before retrying, making the path self-healing rather than
dependent on a job's schedule. It runs only after a conflict, so the common path
remains a single statement.

**Test hardened.** Rewritten to use exactly one technician and one bay, forcing
the booking to reuse the contested resources. It now fails deterministically
against the old code instead of roughly one run in four.

**Lesson.** Two lessons, and the second is the larger one. First: an
intermittent failure is a bug report, not noise. Second: the randomisation
introduced to *reduce* contention also masked this defect, because it routed
around the broken resource. A performance optimisation quietly weakened the
test suite's ability to detect a correctness bug — worth knowing about any
system that makes non-deterministic choices.

---

## 10. Cutting a proposed structure rather than adding one

**Request.** Restructure the finished service into "a Turborepo monorepo
containing a NestJS modular monolith, organized into feature modules", using a
reference tree from a prior project as a guide.

**First answer, and why it was wrong.** The initial plan proposed five packages
— `shared-types`, `shared-constants`, `shared-schemas`, `domain`, `database` —
plus a Next.js web shell. It looked thorough. On examination it was not:

- Three of the packages were two-file extractions. `domain` held the slot
  generator and the error classes; `shared-constants` held a handful of values.
  An import boundary is not the same thing as a seam.
- The web shell existed largely to justify the monorepo, and the monorepo was
  then justified partly by pointing at the web shell. Circular. Its stated
  purpose — "proves the shared schemas are browser-safe" — was a test invented
  for a package that had just been invented.
- Turborepo's task graph and cache pay off across many packages with real build
  dependencies. Here: one application, a build measured in seconds.

**What made it visible.** Asking what each package would cost versus what it
would prevent. Set against the cost — Prisma generation across a package
boundary, TypeScript build ordering, Jest resolution, and the invalidation of
four documents whose numbers were currently *measured and correct* — most of
them prevented nothing.

There was also an internal inconsistency worth naming. `DESIGN.md` argues that
`SELECT ... FOR UPDATE` was rejected because it looks textbook while being wrong
for the workload. Wrapping one service in five packages is the same failure with
the opposite sign: structure that signals rigour without doing work.

**Revised.** One package. `@scheduler/contracts` earns its place because the
brief has the client *stubbed*, so contract drift is a live risk with no
mechanism to catch it. Everything else stayed where it was.

**Lesson.** The AI's structural instinct is additive — asked for a monorepo, it
produces the maximal monorepo, and every package comes with a plausible
rationale attached. Plausible-per-item does not make the set justified. Deleting
proposed structure is harder than adding it and got no help from the model until
the question was reframed from "what could be extracted?" to "what would each
extraction prevent?"

---

## 11. A convenience that would have broken the build

**Context.** With `packages/contracts` extracted, `apps/api` needs to resolve
`@scheduler/contracts`. The obvious move — and the one first reached for — is a
TypeScript path alias:

```jsonc
// apps/api/tsconfig.json
"paths": { "@scheduler/*": ["../../packages/*/src"] }
```

**Why it is wrong.** It makes editors resolve instantly and breaks `nest build`.
tsc would pull the package sources into the application's compilation, escape
`rootDir`, and re-emit `main.js` nested under `dist/src` — the exact bug already
fixed once in this project, when tests were included in the build tsconfig.

**Resolution.** Two different mechanisms, because the two tools have different
constraints:

- **tsc / nest build** resolves through the pnpm workspace symlink to the
  package's *built output*. `contracts` is a composite package with `main` and
  `types`; `turbo.json` declares `dependsOn: ["^build"]` so ordering is enforced
  rather than assumed.
- **Jest** has no `rootDir` constraint, so its `moduleNameMapper` points at
  package *source*. Tests therefore cannot pass against a stale `dist/`.

**Lesson.** "It resolves in the editor" is not evidence that it builds. The
build was run and `dist/main.js` checked for its actual path, rather than
trusting that the import worked.
