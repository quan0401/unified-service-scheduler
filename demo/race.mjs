// Fires N booking requests in a single tick. Unlike a shell loop, every request
// is dispatched before the event loop yields, so their SELECTs land inside the
// winner's commit window -- which is the only way the exclusion constraint is
// ever consulted.
const API = process.env.API ?? 'http://localhost:13000';
const N = Number(process.env.N ?? 200);
const body = process.env.BODY;

const started = Date.now();
const results = await Promise.all(
  Array.from({ length: N }, () =>
    fetch(`${API}/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
      .then((r) => r.status)
      .catch((e) => `ERR:${e.cause?.code ?? e.message}`),
  ),
);
const elapsed = Date.now() - started;

const tally = results.reduce((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {});
console.log(`fired ${N} in one tick, settled in ${elapsed}ms`);
for (const [status, count] of Object.entries(tally).sort()) {
  console.log(`  ${status}: ${count}`);
}
