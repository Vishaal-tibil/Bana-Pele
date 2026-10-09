// status.js -- checks Beckn status / on_status: POST /v1/status/{tx}/refresh
// and the automatic check that catches up on missed callbacks.
//
//   API_KEY=<key> node tests/status.js
//
// Against the running stack it checks that a refresh is accepted and never
// changes a request that is already in the right state.
//
// With RELAY set it also loses callbacks on purpose and proves they are
// recovered. That needs the two apps running behind tests/beckn-relay.js
// (no Docker needed):
//   node tests/beckn-relay.js &
//   ONIX_CALLER=http://localhost:4100/bap node our-backend-naledi/backbone-bpp-server.js &
//   BACKBONE_CALLER=http://localhost:4100/bpp STATUS_SWEEP_MS=2000 STATUS_RECHECK_MS=1000 STATUS_SELECT_GRACE_MS=3000 \
//     node our-backend-naledi/frontdoor-bap-server.js &
//   BAP=http://localhost:4000 RELAY=http://localhost:4100 API_KEY=... node tests/status.js

'use strict';

const BAP = process.env.BAP || 'http://localhost:3001';
const KEY = process.env.API_KEY || 'demo-key-change-me';
const RELAY = process.env.RELAY || '';
const P = `prac_status_${Date.now().toString(36)}`;

let passed = 0;
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function section(t) { console.log(`\n== ${t}`); }
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 300) : ''}`); }
}
async function api(method, path, body) {
  const res = await fetch(BAP + path, {
    method,
    headers: { 'X-Api-Key': KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
  return { status: res.status, body: json };
}
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(200); }
  return false;
}
const statusOf = async (tx) => (await api('GET', `/v1/status/${tx}`)).body.status;
const refresh = (tx) => api('POST', `/v1/status/${tx}/refresh`);
const drop = (action) => fetch(`${RELAY}/drop/${action}`, { method: 'POST' });

async function newRequest(needType) {
  const s = await api('POST', '/v1/search', { practitionerId: P, needType, region: 'Gauteng' });
  const tx = s.body.transactionId;
  await until(async () => ((await api('GET', `/v1/results/${tx}`)).body.results || []).length > 0);
  const results = (await api('GET', `/v1/results/${tx}`)).body.results || [];
  return { tx, providerId: results[0] && results[0].providerId, needType };
}
async function select(r) {
  const s = await api('POST', '/v1/select', { transactionId: r.tx, practitionerId: P, needType: r.needType, providerId: r.providerId });
  // wait until the provider side holds the request, so a decision can find it
  await sleep(600);
  return s;
}

(async () => {
  section('refresh: basic answers');
  check('unknown transaction -> 404', (await refresh('no-such-tx')).status === 404);
  const a = await newRequest('registration');
  check('search found a provider', !!a.providerId, a);
  const r0 = await refresh(a.tx);
  check('before select -> 409 nothing_to_check', r0.status === 409 && r0.body.error === 'nothing_to_check', r0);

  section('refresh never changes a request that is already right');
  await select(a);
  const r1 = await refresh(a.tx);
  check('pending -> 202 checking', r1.status === 202 && r1.body.checking === true, r1);
  await sleep(1000);
  check('still pending (provider has not decided)', (await statusOf(a.tx)) === 'pending');

  if (RELAY) await drop('on_init');
  const d = await api('POST', '/v1/provider/decision', { transactionId: a.tx, decision: 'accept', coachId: 'coach_status_test' });
  check('provider accepts', d.status === 200, d);
  if (RELAY) {
    await sleep(800);
    check('lost on_init: still pending (or already fixed by the automatic check)', ['pending', 'reserved'].includes(await statusOf(a.tx)));
    await refresh(a.tx);
  }
  check('reserved', await until(async () => (await statusOf(a.tx)) === 'reserved'));
  await refresh(a.tx);
  await sleep(1000);
  check('reserved stays reserved after a refresh', (await statusOf(a.tx)) === 'reserved');

  await api('POST', '/v1/confirm', { transactionId: a.tx });
  if (RELAY) await drop('on_confirm');
  const c = await api('POST', '/v1/provider/complete', { transactionId: a.tx });
  check('provider completes', c.status === 200, c);
  if (RELAY) {
    await sleep(600);
    check('lost on_confirm: still confirming (or already fixed by the automatic check)', ['confirming', 'fulfilled'].includes(await statusOf(a.tx)));
    check('the automatic check (no refresh call) -> fulfilled', await until(async () => (await statusOf(a.tx)) === 'fulfilled', 15000));
    const ev = (await api('GET', '/v1/events')).body;
    const fixed = (Array.isArray(ev) ? ev : ev.events || []).filter((e) => e.transactionId === a.tx && e.event === 'status.changed' && e.payload && e.payload.via === 'status');
    check('each correction sent a status.changed event (via: status)', fixed.map((e) => e.status).join() === 'reserved,fulfilled', fixed.map((e) => e.status));
  }
  check('fulfilled', await until(async () => (await statusOf(a.tx)) === 'fulfilled'));
  await refresh(a.tx);
  await sleep(1000);
  check('fulfilled stays fulfilled after a refresh', (await statusOf(a.tx)) === 'fulfilled');
  const log = (await api('GET', `/v1/log/${a.tx}`)).body;
  check('the log records the checks', JSON.stringify(log).includes('status check'), Array.isArray(log) ? log.length : log);

  section('declined and withdrawn requests');
  const b = await newRequest('nutrition');
  await select(b);
  if (RELAY) await drop('on_init');
  await api('POST', '/v1/provider/decision', { transactionId: b.tx, decision: 'decline' });
  if (RELAY) {
    await sleep(600);
    await refresh(b.tx); // too soon after the select: a REJECTED answer is not trusted yet
    await sleep(600);
    check('lost on_init: a check right after the select keeps it pending', (await statusOf(b.tx)) === 'pending');
  }
  check('declined -> rejected', await until(async () => (await statusOf(b.tx)) === 'rejected', 15000));
  await refresh(b.tx);
  await sleep(1000);
  check('rejected stays rejected after a refresh', (await statusOf(b.tx)) === 'rejected');

  const w = await newRequest('infrastructure');
  await select(w);
  await api('POST', '/v1/provider/decision', { transactionId: w.tx, decision: 'accept' });
  await until(async () => (await statusOf(w.tx)) === 'reserved');
  if (RELAY) await drop('on_cancel');
  await api('POST', '/v1/withdraw', { transactionId: w.tx });
  if (RELAY) {
    await sleep(600);
    check('lost on_cancel: still withdrawing (or already fixed by the automatic check)', ['withdrawing', 'withdrawn'].includes(await statusOf(w.tx)));
    await refresh(w.tx);
  }
  check('withdrawn', await until(async () => (await statusOf(w.tx)) === 'withdrawn'));
  await refresh(w.tx);
  await sleep(1000);
  check('withdrawn stays withdrawn after a refresh', (await statusOf(w.tx)) === 'withdrawn');

  if (RELAY) {
    section('messages on the wire');
    const rep = await (await fetch(`${RELAY}/report`)).json();
    check('status and on_status were sent', rep.seen.status > 0 && rep.seen.on_status > 0, rep.seen);
    if (rep.schemaChecks) check('every message matches the Beckn 2.0 schema', rep.invalid.length === 0, rep.invalid);
  }

  console.log(`\n==== ${passed} passed, ${failures.length} failed ====`);
  if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
