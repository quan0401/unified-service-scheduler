# cURL Walkthrough

The complete booking flow as copy-pasteable shell. This is the test harness the
brief asks for in place of a client application — it exercises every endpoint,
including the refusal paths that matter most.

## Prerequisites

```bash
cd apps/api
pnpm install
pnpm prisma migrate deploy
pnpm db:seed          # prints the ids used below
pnpm start:dev
```

Every response uses the same envelope, so `jq` paths are uniform:

```json
{ "success": true, "data": {}, "error": null, "meta": { "requestId": "..." } }
```

## Capture the ids

`Northgate Auto` is the interesting dealership: exactly one bay in its estate
handles transmission work, so it is where contention is visible.

```bash
API=http://localhost:3000

DEALERSHIP=$(curl -s "$API/dealerships" \
  | jq -r '.data[] | select(.name=="Northgate Auto") | .id')

SERVICE=$(curl -s "$API/service-types" \
  | jq -r '.data[] | select(.name=="Transmission Repair") | .id')

CUSTOMER=$(curl -s "$API/dealerships" >/dev/null; \
  psql -d scheduler -tAc "select id from customer where email='daniel.okafor@example.com'")

VEHICLE=$(curl -s "$API/customers/$CUSTOMER/vehicles" | jq -r '.data[0].id')

echo "dealership=$DEALERSHIP service=$SERVICE customer=$CUSTOMER vehicle=$VEHICLE"
```

## 1. Availability

Advisory only. A slot reported free here can be taken a moment later — booking
re-checks atomically, so this is a view rather than a reservation.

```bash
curl -s "$API/availability?dealershipId=$DEALERSHIP&serviceTypeId=$SERVICE&date=2026-09-07" \
  | jq '.data | {timezone, durationMinutes, slots: (.slots | length),
                 first: .slots[0], last: .slots[-1]}'
```

Northgate opens 07:30–17:30 London time. A 240-minute service yields 25 slots,
the last starting 13:30 local so it finishes exactly at closing.

## 2. Hold the slot

Reserves it for two minutes while the customer completes their booking. Without
this step, users lose slots at submit time whenever the dealership is busy.

```bash
BODY=$(cat <<JSON
{
  "dealershipId": "$DEALERSHIP",
  "customerId": "$CUSTOMER",
  "vehicleId": "$VEHICLE",
  "serviceTypeId": "$SERVICE",
  "startAt": "2026-09-07T06:30:00Z"
}
JSON
)

HOLD=$(curl -s -X POST "$API/holds" -H 'Content-Type: application/json' -d "$BODY")
HOLD_ID=$(echo "$HOLD" | jq -r '.data.id')
echo "$HOLD" | jq '.data | {id, status, holdExpiresAt, expiresInSeconds}'
```

## 3. A competitor is blocked while the hold is live

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST "$API/appointments" -H 'Content-Type: application/json' -d "$BODY"
# 409
```

## 4. Confirm the hold

The hold is promoted **in place** — the returned id equals `HOLD_ID`. The row
never leaves the exclusion constraints, so the slot is not momentarily released
between reserving and confirming.

```bash
APPOINTMENT=$(curl -s -X POST "$API/appointments" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: walkthrough-001' \
  -d "$(echo "$BODY" | jq --arg h "$HOLD_ID" '. + {holdId: $h}')")

echo "$APPOINTMENT" | jq '.data | {id, status, startAt, endAt,
  customer: .customer.name, vehicle: (.vehicle.make + " " + .vehicle.model),
  technician: .technician.name, bay: .serviceBay.name}'
```

That output is Requirement 3: a persistent record associating customer, vehicle,
technician, and service bay.

## 5. Idempotent replay

A retried request — from a client, or a load balancer — must not create a second
appointment.

```bash
curl -s -X POST "$API/appointments" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: walkthrough-001' \
  -d "$(echo "$BODY" | jq --arg h "$HOLD_ID" '. + {holdId: $h}')" \
  | jq '.data | {id, replayed}'

psql -d scheduler -tAc \
  "select count(*) from appointment where idempotency_key='walkthrough-001'"
# 1
```

## 6. Refusals

Each returns a distinct status and machine-readable code, so a client can branch
without parsing prose.

```bash
# A vehicle that exists but belongs to another customer -> 403 VEHICLE_NOT_OWNED.
# It has to be a real vehicle: a nonexistent id is a 404, which proves nothing
# about the ownership rule.
OTHER_CUSTOMER=$(psql -d scheduler -tAc \
  "select id from customer where email='mei.chen@example.com'")
OTHER_VEHICLE=$(curl -s "$API/customers/$OTHER_CUSTOMER/vehicles" | jq -r '.data[0].id')

curl -s -X POST "$API/appointments" -H 'Content-Type: application/json' \
  -d "$(echo "$BODY" | jq --arg v "$OTHER_VEHICLE" '.vehicleId = $v')" \
  | jq -c '{status: "403", code: .error.code}'

# Unknown vehicle -> 404 VEHICLE_NOT_FOUND
curl -s -X POST "$API/appointments" -H 'Content-Type: application/json' \
  -d "$(echo "$BODY" | jq '.vehicleId = "00000000-0000-4000-8000-000000000000"')" \
  | jq -c '{status: "404", code: .error.code}'

# Outside opening hours -> 422 OUTSIDE_OPENING_HOURS
curl -s -X POST "$API/appointments" -H 'Content-Type: application/json' \
  -d "$(echo "$BODY" | jq '.startAt = "2026-09-08T03:00:00Z"')" \
  | jq -c '{status: "422", code: .error.code}'

# Malformed input -> 400 BAD_REQUEST, rejected before the database is touched
curl -s -X POST "$API/appointments" -H 'Content-Type: application/json' \
  -d "$(echo "$BODY" | jq '.startAt = "not-a-timestamp"')" \
  | jq -c '{status: "400", code: .error.code}'
```

## 7. Cancel, and watch the slot return

Cancellation is a status change, not a delete. The record survives for audit;
the slot becomes bookable because the exclusion constraints only apply to `HELD`
and `CONFIRMED` rows.

```bash
APPT_ID=$(echo "$APPOINTMENT" | jq -r '.data.id')
curl -s -o /dev/null -w 'cancel: %{http_code}\n' -X DELETE "$API/appointments/$APPT_ID"

curl -s -X POST "$API/appointments" -H 'Content-Type: application/json' -d "$BODY" \
  | jq -c '{success, status: .data.status}'
# rebooked
```

## 8. Prove the concurrency guarantee

The claim this system rests on: simultaneous requests for one slot produce
exactly one appointment. Fire 50 at once and count.

The default rate limit is 20 requests per second **per IP**, so firing 50
requests from one shell trips it — you will see `429`s mixed in. That is the
throttler working, but it obscures what this demo is measuring. Restart the
server with a raised ceiling first:

```bash
THROTTLE_BURST_LIMIT=1000 THROTTLE_SUSTAINED_LIMIT=10000 pnpm start:dev
```

In production this dilution does not arise: fifty customers arrive from fifty
addresses, and the per-IP limit never engages.

```bash
# Free the slot first
psql -d scheduler -tAc \
  "update appointment set status='CANCELLED', cancelled_at=now(), hold_expires_at=null
   where start_at='2026-09-07T06:30:00Z' and status in ('HELD','CONFIRMED')"

for i in $(seq 1 50); do
  curl -s -o /dev/null -w '%{http_code}\n' \
    -X POST "$API/appointments" -H 'Content-Type: application/json' -d "$BODY" &
done | sort | uniq -c
wait

psql -d scheduler -tAc \
  "select count(*) from appointment
   where start_at='2026-09-07T06:30:00Z' and status='CONFIRMED'"
# 1
```

One `201`, forty-nine `409`, and exactly one row.

Note that losers report `SLOT_UNAVAILABLE` rather than `SLOT_CONTENDED`: the
winner commits fast enough that the others' availability filter already sees the
slot taken. The exclusion constraint is the backstop for the genuinely
simultaneous window, not the everyday path — which is why
`booking_conflicts_total` usually stays at zero even under this load.

The automated equivalent, at 200 concurrent requests with database-level
assertions, is `apps/api/test/concurrency/booking-race.e2e-spec.ts`.

## 9. Observability

```bash
curl -s "$API/health"        | jq -c '.data'
curl -s "$API/health/ready"  | jq -c '.data'

# Domain metrics -- plain text, Prometheus exposition format
curl -s "$API/metrics" | grep -E '^booking_|^holds_active'
```

`booking_conflicts_total` and `booking_retry_exhausted_total` are the two
numbers that distinguish "genuinely fully booked" from "the system is fighting
itself".

`$API` above is the API's own port. `/metrics` is not reachable through the
public edge — nginx returns 404 for `/api/metrics` — so against the deployed
site this last command needs a scraper on the compose network, or Grafana over
a Session Manager port forward. `/health` and `/health/ready` are public and
work either way.

## Interactive API reference

Swagger UI is served at <http://localhost:3000/docs>, generated from the same
Zod schemas the server validates against — so it cannot drift from the
implementation. The document is also committed at `apps/api/docs/openapi.json`.
