#!/usr/bin/env python3
"""Live verification against a deployed instance.

Exercises the properties the deployment is supposed to preserve, not just
liveness: the config that arrived via the GitHub-fetched compose file, seed data
surviving a redeploy, idempotent booking through TLS and the reverse proxy, and
the exclusion constraints under real concurrency.

The unit and integration suites cannot reach any of this. They run against a
local database with no proxy in front of it, so a wrong OpenAPI base path, a
stripped Idempotency-Key, an untrusted certificate, or a connection pool sized
from the container's CPU count all pass locally and fail in production. Two such
bugs were found this way and are recorded in the runbook.

Usage:
    python3 infra/live-test.py https://<elastic-ip>
    SCHEDULER_URL=https://<elastic-ip> python3 infra/live-test.py

Standard library only, so it runs anywhere without a virtualenv. Exits non-zero
on the first failing property, which makes it usable as a deploy gate.
"""

import datetime
import json
import os
import random
import ssl
import sys
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor

BASE = (len(sys.argv) > 1 and sys.argv[1]) or os.environ.get("SCHEDULER_URL")
if not BASE:
    sys.exit("usage: live-test.py <base-url>   (or set SCHEDULER_URL)")
BASE = BASE.rstrip("/")

# Deliberately a verifying context. Passing -k, or setting CERT_NONE here, would
# make an expired or mis-issued certificate invisible to the suite -- and
# renewal failure is a realistic way for this deployment to break, especially on
# the Elastic-IP path where Let's Encrypt forces the six-day "shortlived"
# profile.
CTX = ssl.create_default_context()

# A random future weekday per run, not a fixed offset. A deterministic date made
# the suite collide with its OWN earlier bookings on a second run the same day
# -- the dealership has two technicians and two bays, so the slot it picks is
# gone the second time and the failure reads exactly like a regression.
_d = datetime.date.today() + datetime.timedelta(days=random.randint(40, 400))
while _d.weekday() > 4:  # dealership opens Monday to Friday
    _d += datetime.timedelta(days=1)
DATE = _d.isoformat()

# Above the 25-connection pool, so this exercises queueing rather than merely
# fitting inside it. At 20 the pool was never saturated and the P2024 bug that
# this number exposed stayed hidden.
RACERS = 40

print(f"{BASE}, booking against {DATE}, {RACERS}-way race\n")


def call(path, method="GET", body=None, headers=None):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"_raw": raw[:120].decode("utf8", "replace")}


results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


# --- config that came from the fetched compose file --------------------------
# An empty servers array makes Swagger's try-it-out resolve against the origin
# root, where nginx answers every unknown path with the SPA -- a 200 with HTML
# in it, which looks like success. This asserts the value that update.sh must
# have brought across with the images.
_, doc = call("/api/docs-json")
servers = doc.get("servers")
check("OpenAPI servers is /api", servers == [{"url": "/api"}], str(servers))

# --- liveness ----------------------------------------------------------------
st, ready = call("/api/health/ready")
check("health/ready", st == 200 and ready["data"]["database"] == "up", str(ready.get("data")))

# --- seed data survived the redeploy -----------------------------------------
# The database lives on a bind mount, not in the container, so this fails if a
# redeploy ever recreates the volume.
_, deals = call("/api/dealerships")
_, svcs = call("/api/service-types")
_, custs = call("/api/customers")
check(
    "seed data intact",
    len(deals["data"]) >= 2 and len(svcs["data"]) >= 3 and len(custs["data"]) >= 2,
    f"{len(deals['data'])} dealerships, {len(svcs['data'])} services, {len(custs['data'])} customers",
)

northgate = next(d for d in deals["data"] if d["name"].startswith("Northgate"))
oil = next(s for s in svcs["data"] if s["name"] == "Oil Change")

# --- availability ------------------------------------------------------------
st, avail = call(
    f"/api/availability?dealershipId={northgate['id']}&serviceTypeId={oil['id']}&date={DATE}"
)
slots = [s for s in avail["data"]["slots"] if s["available"]]
check("availability returns open slots", st == 200 and len(slots) > 0, f"{len(slots)} open")

# --- a bookable customer + vehicle -------------------------------------------
# Read the vehicle from the customer, not from an existing appointment: the
# first customer may have never booked anything, which is how an earlier version
# of this harness produced a false failure.
cust = custs["data"][0]
st, vehicles = call(f"/api/customers/{cust['id']}/vehicles")
vehicle_id = vehicles["data"][0]["id"] if st == 200 and vehicles["data"] else None
check(
    "customer vehicles endpoint",
    vehicle_id is not None,
    f"{len(vehicles.get('data') or [])} vehicles for {cust['name']}",
)

if vehicle_id and slots:
    slot = slots[len(slots) // 2]["startAt"]
    payload = {
        "dealershipId": northgate["id"],
        "customerId": cust["id"],
        "vehicleId": vehicle_id,
        "serviceTypeId": oil["id"],
        "startAt": slot,
    }

    # --- idempotency ---------------------------------------------------------
    # Also the check that the proxy forwards Idempotency-Key. If the header were
    # dropped in transit the second call would book a second appointment and
    # this would report two different ids.
    key = f"live-{uuid.uuid4()}"
    hdr = {"Idempotency-Key": key, "X-Request-Id": "live-probe"}
    s1, r1 = call("/api/appointments", "POST", payload, hdr)
    s2, r2 = call("/api/appointments", "POST", payload, hdr)
    id1 = (r1.get("data") or {}).get("id")
    id2 = (r2.get("data") or {}).get("id")
    check(
        "idempotent replay returns the same appointment",
        s1 == 201 and id1 is not None and id1 == id2,
        f"{s1}/{s2} {id1} == {id2}",
    )

    # --- concurrency: exclusion constraints ----------------------------------
    # The one property that cannot be verified by reading code: that the GiST
    # exclusion constraints actually reached the deployed database through
    # `prisma migrate deploy` running inside the container.
    contested = next(
        (s["startAt"] for s in slots if s["startAt"] != slot and s.get("bayCount", 0) >= 1),
        None,
    )
    if contested:
        race = {**payload, "startAt": contested}

        def attempt(_):
            st, body = call(
                "/api/appointments", "POST", race, {"Idempotency-Key": f"race-{uuid.uuid4()}"}
            )
            return st, (body.get("data") or {}).get("id"), (body.get("error") or {}).get("code")

        with ThreadPoolExecutor(max_workers=RACERS) as pool:
            out = list(pool.map(attempt, range(RACERS)))

        won = {i for _, i, _ in out if i}
        codes = {}
        for st_, _, code in out:
            codes[code or st_] = codes.get(code or st_, 0) + 1
        # The outcome breakdown is printed even on success, because "one winner"
        # is true both when the losers get a clean 409 and when they get a 500.
        # Reading the codes is what caught the two error-classification bugs.
        check(
            f"{RACERS} concurrent bookings produce exactly one winner",
            len(won) == 1,
            f"winners={len(won)} outcomes={codes}",
        )

# --- exposure ----------------------------------------------------------------
st, _ = call("/api/health")
check("TLS chain verifies without -k", st == 200, "urllib verified the cert")

print()
failed = [n for n, ok, _ in results if not ok]
print(f"{len(results) - len(failed)}/{len(results)} passed")
if failed:
    print("FAILED:", ", ".join(failed))
    raise SystemExit(1)
