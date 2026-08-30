-- The correctness guarantee of this system.
--
-- "Check availability, then confirm" is a check-then-act race: two requests can
-- both observe a free bay and both insert. Application-level checking cannot
-- close that window -- only the database can, because only the database sees
-- both writes. These constraints make an overlapping booking physically
-- impossible regardless of application bugs, retry logic, or replica count.
--
-- Why GiST exclusion rather than SELECT ... FOR UPDATE on the resource row:
-- a row lock locks the *technician*, not the *time slot*, so a 09:00 booking
-- would block an unrelated 15:00 booking for the same technician. Exclusion
-- constraints conflict only on (resource, overlapping range) -- the finest
-- granularity available -- so non-overlapping bookings proceed fully in
-- parallel. This is what lets the system be both correct and concurrent.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Bounds are '[)' -- half-open. An appointment ending at 10:00 and one starting
-- at 10:00 do not overlap, so back-to-back bookings are allowed.
--
-- The predicate includes HELD so a reservation genuinely blocks competitors
-- while a customer completes the booking form. CANCELLED and COMPLETED rows are
-- excluded: cancelled slots must be rebookable, and the index stays small.

ALTER TABLE "appointment"
  ADD CONSTRAINT "appointment_no_technician_overlap"
  EXCLUDE USING gist (
    "technician_id" WITH =,
    tstzrange("start_at", "end_at", '[)') WITH &&
  ) WHERE ("status" IN ('HELD', 'CONFIRMED'));

ALTER TABLE "appointment"
  ADD CONSTRAINT "appointment_no_bay_overlap"
  EXCLUDE USING gist (
    "service_bay_id" WITH =,
    tstzrange("start_at", "end_at", '[)') WITH &&
  ) WHERE ("status" IN ('HELD', 'CONFIRMED'));

-- One vehicle cannot be in two bays at once. Guards against a customer
-- double-booking the same car, which the other two constraints would permit.
ALTER TABLE "appointment"
  ADD CONSTRAINT "appointment_no_vehicle_overlap"
  EXCLUDE USING gist (
    "vehicle_id" WITH =,
    tstzrange("start_at", "end_at", '[)') WITH &&
  ) WHERE ("status" IN ('HELD', 'CONFIRMED'));

-- An appointment must occupy a positive span of time.
ALTER TABLE "appointment"
  ADD CONSTRAINT "appointment_end_after_start" CHECK ("end_at" > "start_at");

-- A hold expiry is meaningful only while the row is HELD.
ALTER TABLE "appointment"
  ADD CONSTRAINT "appointment_hold_expiry_only_when_held"
  CHECK (("status" = 'HELD') = ("hold_expires_at" IS NOT NULL));
