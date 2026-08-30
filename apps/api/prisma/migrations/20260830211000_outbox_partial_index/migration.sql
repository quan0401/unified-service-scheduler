-- Keeps the relay's claim index proportional to the work outstanding, not to
-- the history of everything ever published.
--
-- The relay has exactly one query: the oldest unpublished events. The previous
-- index on ("published_at", "created_at") can serve it, but it indexes every
-- row forever -- published events are never deleted, so it grows without bound
-- while the set of rows it usefully serves stays near zero. Every claim then
-- pays to traverse a structure that is almost entirely dead entries.
--
-- A partial index holds only unpublished rows. Publishing an event removes it
-- from the index rather than merely updating its position, so the index stays
-- roughly constant-sized under steady state.
--
-- This is the same reasoning the hold sweeper exists to serve: see
-- src/modules/background-jobs/hold-sweeper.service.ts, which keeps expired
-- holds out of the exclusion constraints' partial indexes for exactly this
-- reason. Prisma's schema language cannot express a partial index, which is
-- why this is hand-written SQL.

CREATE INDEX "outbox_event_unpublished_idx"
  ON "outbox_event" ("created_at")
  WHERE "published_at" IS NULL;

DROP INDEX "outbox_event_published_at_created_at_idx";
