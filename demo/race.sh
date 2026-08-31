#!/usr/bin/env bash
# Live concurrency demo: N simultaneous bookings of one scarce slot.
#
# Fires from a single Node process rather than a shell loop. Shelled-out curls
# spawn milliseconds apart -- wider than the window in which requests can
# actually contend -- so they queue politely and the demo proves nothing.
set -euo pipefail
cd "$(dirname "$0")/.."

API=${API:-http://localhost:13000}
N=${N:-50}
SLOT=${SLOT:-2026-09-07T06:30:00Z}

psql_() { PGPASSWORD=scheduler psql -h localhost -p 55432 -U scheduler -d scheduler -tAc "$1"; }
metric() { curl -s "$API/metrics" | awk -v k="^$1 " '$0 ~ k {print $2}'; }

DEALERSHIP=$(curl -s "$API/dealerships" | jq -r '.data[] | select(.name=="Northgate Auto") | .id')
SERVICE=$(curl -s "$API/service-types"  | jq -r '.data[] | select(.name=="Transmission Repair") | .id')
CUSTOMER=$(psql_ "select id from customer where email='daniel.okafor@example.com'" | tr -d '[:space:]')
VEHICLE=$(curl -s "$API/customers/$CUSTOMER/vehicles" | jq -r '.data[0].id')

BODY=$(jq -nc --arg d "$DEALERSHIP" --arg c "$CUSTOMER" --arg v "$VEHICLE" \
              --arg s "$SERVICE"    --arg t "$SLOT" \
  '{dealershipId:$d, customerId:$c, vehicleId:$v, serviceTypeId:$s, startAt:$t}')

# Clear the window so the demo is deterministic across retakes: after this, every
# row for this slot was written by the race we are about to run. A hard delete
# rather than a cancellation, because leftover CANCELLED rows from an earlier
# take would make the "only one row exists" count read higher than 1.
cleared=$(psql_ "with gone as (delete from appointment where start_at='$SLOT' returning 1)
                 select count(*) from gone" | tr -d '[:space:]')
echo "Cleared $cleared existing row(s) at $SLOT -- the window is now empty"
echo

before_conflicts=$(metric booking_conflicts_total)
before_exhausted=$(metric booking_retry_exhausted_total)

API="$API" N="$N" BODY="$BODY" node demo/race.mjs

echo
echo "booking_conflicts_total        +$(( $(metric booking_conflicts_total) - before_conflicts ))"
echo "booking_retry_exhausted_total  +$(( $(metric booking_retry_exhausted_total) - before_exhausted ))"
