-- Verification for the live concurrency demo.
-- Run inside psql:  \i demo/verify.sql

\set slot '2026-09-07T06:30:00Z'
\pset border 2

\echo
\echo '=== 1. Live booking for the contended window (expect exactly 1) ==='
SELECT a.status,
       t.name AS technician,
       b.name AS bay,
       a.start_at,
       a.end_at
FROM appointment a
JOIN technician  t ON t.id = a.technician_id
JOIN service_bay b ON b.id = a.service_bay_id
WHERE a.start_at = :'slot'::timestamptz
  AND a.status IN ('HELD', 'CONFIRMED');

\echo
\echo '=== 2. Total rows the race wrote (expect 1 -- the other 49 wrote nothing) ==='
SELECT count(*) AS rows_for_this_window
FROM appointment
WHERE start_at = :'slot'::timestamptz;

\echo
\echo '=== 3. No two live bookings share a bay or technician in overlapping time (expect 0 rows) ==='
SELECT a.id AS appointment_a,
       b.id AS appointment_b,
       CASE WHEN a.service_bay_id = b.service_bay_id
            THEN 'same bay' ELSE 'same technician' END AS collision
FROM appointment a
JOIN appointment b
  ON a.id < b.id
 AND (a.service_bay_id = b.service_bay_id OR a.technician_id = b.technician_id)
 AND tstzrange(a.start_at, a.end_at, '[)')
  && tstzrange(b.start_at, b.end_at, '[)')
WHERE a.status IN ('HELD', 'CONFIRMED')
  AND b.status IN ('HELD', 'CONFIRMED')
  AND (a.status = 'CONFIRMED' OR a.hold_expires_at > now())
  AND (b.status = 'CONFIRMED' OR b.hold_expires_at > now());

\echo
\echo '=== 4. Why it cannot be otherwise: what PostgreSQL enforces on every write ==='
\x on
SELECT conname AS constraint_name,
       pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'appointment'::regclass
  AND contype = 'x';
\x off
