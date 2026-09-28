// e2e.js -- end-to-end verification of OUR side of the My Journey connection.
//
// It plays the part of My Journey's backend: it calls our /v1 API, and (in
// --delegated mode) checks that events really arrive at a partner webhook
// (the stand-in mock-mjourney service). It also restarts containers to prove
// state survives, and finally audits the ONIX adapters' own logs.
//
//   node tests/e2e.js               standalone mode (no partner configured)
//   node tests/e2e.js --delegated   partner configured (MATCH_URL / EVENTS_URL -> mock)
//
// Needs Node 18+, the stack running, and the `docker` CLI on this machine.

'use strict';

const { spawnSync } = require('child_process');

const BAP = process.env.BAP || 'http://localhost:3001';
const BPP = process.env.BPP || 'http://localhost:3002';
const MOCK = process.env.MOCK || 'http://localhost:3003';
const KEY = process.env.API_KEY || 'demo-key-change-me';
const DELEGATED = process.argv.includes('--delegated');
const T0 = new Date(Date.now() - 2000).toISOString();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];

function section(title) {
  console.log(`\n== ${title}`);
}
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail !== undefined ? '  -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
  }
  return !!cond;
}

async function call(base, method, path, body, headers) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
  return { status: res.status, body: json };
}
const api = (method, path, body, key = KEY) => call(BAP, method, path, body, key ? { 'X-Api-Key': key } : {});
const bpp = (method, path, body, key = KEY) => call(BPP, method, path, body, key ? { 'x-internal-key': key } : {});
const mock = (method, path, body) => call(MOCK, method, path, body, {});

async function waitFor(fn, timeout = 9000, every = 250) {
  const end = Date.now() + timeout;
  for (;;) {
    let v;
    try { v = await fn(); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

const statusOf = async (tx) => (await api('GET', `/v1/status/${tx}`)).body;
async function waitStatus(tx, want, timeout = 9000) {
  let last = null;
  await waitFor(async () => { last = (await statusOf(tx)).status; return last === want; }, timeout);
  return last;
}
async function search(practitionerId, extra = {}) {
  const r = await api('POST', '/v1/search', { practitionerId, needType: 'registration', region: 'Alexandra', tier: 'Pre-Bronze', children: 28, ...extra });
  return { tx: r.body.transactionId, http: r.status, body: r.body };
}
async function searchReady(practitionerId, extra) {
  const s = await search(practitionerId, extra);
  const st = await waitStatus(s.tx, 'results_ready');
  return { ...s, ready: st === 'results_ready' };
}
const select = (tx, practitionerId, providerId = 'provider-wehelp', needType = 'registration') =>
  api('POST', '/v1/select', { transactionId: tx, practitionerId, needType, providerId });

async function allEvents() {
  const a = (await api('GET', '/v1/events')).body;
  const b = ((await bpp('GET', '/internal/state')).body || {}).outbox || [];
  return [...(Array.isArray(a) ? a : []), ...b];
}
const bppState = async () => (await bpp('GET', '/internal/state')).body;
const eventFor = async (tx, name, pred = () => true) =>
  (await allEvents()).find((e) => e.transactionId === tx && e.event === name && pred(e));
const waitEvent = (tx, name, pred) => waitFor(() => eventFor(tx, name, pred));
const pendingFor = async (needId) => ((await bppState()).pending || []).filter((p) => p.needId === needId);
const needOf = async (needId) => ((await bppState()).needs || []).find((n) => n.id === needId);

function docker(args) {
  const r = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return `${r.stdout || ''}${r.stderr || ''}`;
}
async function waitHealthy(timeout = 45000) {
  return waitFor(async () => {
    const a = await call(BAP, 'GET', '/api/health', null, {});
    const b = await call(BPP, 'GET', '/api/health', null, {});
    return a.status === 200 && b.status === 200;
  }, timeout, 500);
}

(async () => {
  console.log(`Mode: ${DELEGATED ? 'DELEGATED (partner = mock)' : 'STANDALONE (local providers)'}   started ${T0}`);

  // ------------------------------------------------------------------
  section('1. Health and authentication');
  let r = await api('GET', '/v1/health', null, null);
  check('GET /v1/health is public and ok', r.status === 200 && r.body.ok === true, r);
  if (DELEGATED) check('events are configured (partner webhook set)', r.body.eventsConfigured === true, r.body);
  else check('standalone: no partner webhook configured', r.body.eventsConfigured === false, r.body);
  r = await api('POST', '/v1/search', { practitionerId: 'x', needType: 'registration' }, null);
  check('call without X-Api-Key -> 401', r.status === 401, r.status);
  r = await api('POST', '/v1/search', { practitionerId: 'x', needType: 'registration' }, 'wrong-key');
  check('call with wrong key -> 401', r.status === 401, r.status);
  r = await api('POST', '/v1/search', { needType: 'registration' });
  check('search without practitionerId -> 400', r.status === 400, r);
  r = await bpp('GET', '/internal/state', null, 'wrong-key');
  check('provider-side internal endpoint rejects a wrong key', r.status === 401, r.status);

  // ------------------------------------------------------------------
  section('2. Reset to a clean state');
  const epoch0 = (await api('GET', '/v1/health', null, null)).body.epoch;
  if (DELEGATED) await mock('POST', '/mock/reset');
  r = await api('POST', '/v1/admin/reset');
  check('reset returns a new epoch and reaches the provider side', r.status === 200 && r.body.epoch === epoch0 + 1 && r.body.providerSide === 'ok', r.body);
  check('no transactions after reset', (await api('GET', '/v1/transactions')).body.length === 0);
  let st = await bppState();
  check('provider side re-seeded: providers present and nothing pending', st.pending.length === 0 && st.needs.length >= 6, { pending: st.pending.length, needs: st.needs.length });

  // ------------------------------------------------------------------
  section('3. Search that matches (Naledi in Alexandra, Pre-Bronze, 28 children)');
  const A = 'prac_e2e_a';
  const a1 = await searchReady(A);
  check('search accepted (202) and reaches results_ready', a1.http === 202 && a1.ready, a1.body);
  const resA = (await api('GET', `/v1/results/${a1.tx}`)).body;
  check('WeHelp is in the results', (resA.results || []).some((x) => x.providerId === 'provider-wehelp'), resA);
  const evMatched = await waitEvent(a1.tx, 'practitioner.matched', (e) => e.providerId === 'provider-wehelp');
  check('"practitioner.matched" event raised for WeHelp', !!evMatched && evMatched.practitionerId === A && evMatched.payload.needType === 'registration', evMatched);

  // ------------------------------------------------------------------
  section('4. Searches that must NOT match');
  const b1 = await searchReady('prac_e2e_b', { region: 'Soweto' });
  check('out-of-area practitioner: results_ready with no providers', b1.ready && ((await api('GET', `/v1/results/${b1.tx}`)).body.results || []).length === 0);
  check('out-of-area practitioner: no "practitioner.matched" event', !(await eventFor(b1.tx, 'practitioner.matched')));
  if (DELEGATED) {
    const b2 = await searchReady('prac_e2e_b2', { children: 60 });
    check('partner rule: 60 children (over the limit) -> no match', b2.ready && ((await api('GET', `/v1/results/${b2.tx}`)).body.results || []).length === 0);
    const b3 = await searchReady('prac_e2e_b3', { tier: 'Silver' });
    check('partner rule: tier Silver (not eligible) -> no match', b3.ready && ((await api('GET', `/v1/results/${b3.tx}`)).body.results || []).length === 0);
  }

  // ------------------------------------------------------------------
  section('5. Two searches at the same time');
  const [c1, c2] = await Promise.all([searchReady('prac_e2e_c1'), searchReady('prac_e2e_c2')]);
  check('different transaction ids', c1.tx && c2.tx && c1.tx !== c2.tx);
  const sc1 = await statusOf(c1.tx);
  const sc2 = await statusOf(c2.tx);
  check('each transaction keeps its own practitioner and results', sc1.practitionerId === 'prac_e2e_c1' && sc2.practitionerId === 'prac_e2e_c2' && sc1.resultsCount === 1 && sc2.resultsCount === 1, [sc1.practitionerId, sc2.practitionerId]);

  // ------------------------------------------------------------------
  section('6. WeHelp sends an offer (second on_discover on Naledi\'s search)');
  r = await api('POST', '/v1/provider/offer', { transactionId: a1.tx, providerId: 'provider-wehelp', title: 'Registration guidance and DSD submission support', area: 'Registration', note: 'Three sessions to get the DSD application submitted.' });
  check('offer accepted by the network', r.status === 200 && r.body.status === 'sent', r);
  const offerSeen = await waitFor(async () => ((await api('GET', `/v1/results/${a1.tx}`)).body.offers || []).length === 1);
  check('offer appears on Naledi\'s transaction', !!offerSeen);
  const evOffer = await waitEvent(a1.tx, 'offer.received');
  check('"offer.received" event raised with the offer details', !!evOffer && evOffer.payload.title.startsWith('Registration guidance') && evOffer.providerId === 'provider-wehelp', evOffer);
  r = await api('POST', '/v1/provider/offer', { transactionId: a1.tx, providerId: 'provider-grow', title: 'x' });
  check('offer from a provider that did not match -> 409', r.status === 409, r);
  r = await api('POST', '/v1/provider/offer', { transactionId: 'no-such-tx', providerId: 'provider-wehelp', title: 'x' });
  check('offer on an unknown transaction -> 404', r.status === 404, r);
  r = await api('POST', '/v1/provider/offer', { transactionId: a1.tx });
  check('offer with missing fields -> 400', r.status === 400, r);

  // ------------------------------------------------------------------
  section('7. Naledi accepts: select + init');
  r = await api('POST', '/v1/confirm', { transactionId: a1.tx });
  check('confirm before anything is reserved -> 409', r.status === 409 && r.body.error === 'not_reserved', r);
  r = await select(a1.tx, A);
  check('select accepted -> pending', r.status === 202 && r.body.status === 'pending', r);
  const evReq = await waitEvent(a1.tx, 'request.received', (e) => e.payload.stage === 'select_init');
  check('"request.received" (select_init) event raised for WeHelp', !!evReq && evReq.providerId === 'provider-wehelp' && evReq.practitionerId === A, evReq);
  check('status is pending while WeHelp decides', (await statusOf(a1.tx)).status === 'pending');
  r = await select(a1.tx, A);
  check('repeating the same select is idempotent (200)', r.status === 200 && r.body.idempotent === true, r);
  r = await select(a1.tx, A, 'provider-grow');
  check('a different provider on the same transaction -> 409', r.status === 409, r);
  let pend = await pendingFor(`${A}:registration`);
  check('exactly one request is queued for this need, in init stage', pend.length === 1 && pend[0].action === 'init' && pend[0].context.transactionId === a1.tx, pend.map((p) => [p.action, p.context.transactionId]));

  // ------------------------------------------------------------------
  section('8. Duplicate protection (server side)');
  const a2 = await searchReady(A);
  r = await select(a2.tx, A);
  check('second request for the same need is sent', r.status === 202, r);
  check('network answers REJECTED -> status rejected', (await waitStatus(a2.tx, 'rejected')) === 'rejected');
  pend = await pendingFor(`${A}:registration`);
  check('the first request is untouched (still the only one queued)', pend.length === 1 && pend[0].context.transactionId === a1.tx);
  check('need is still open until WeHelp decides', (await needOf(`${A}:registration`)).status === 'open');

  // ------------------------------------------------------------------
  section('9. WeHelp accepts and assigns a coach');
  r = await api('POST', '/v1/provider/decision', { transactionId: a2.tx, decision: 'accept' });
  check('decision on a transaction with no pending request -> 404', r.status === 404, r);
  r = await api('POST', '/v1/provider/decision', { transactionId: a1.tx, decision: 'maybe' });
  check('invalid decision value -> 400', r.status === 400, r);
  r = await api('POST', '/v1/provider/decision', { transactionId: a1.tx, decision: 'accept', coachId: 'coach_thabo_nkosi' });
  check('accept with a coach', r.status === 200 && r.body.needStatus === 'reserved', r);
  check('Naledi\'s side shows reserved', (await waitStatus(a1.tx, 'reserved')) === 'reserved');
  const evRes = await waitEvent(a1.tx, 'status.changed', (e) => e.status === 'reserved');
  check('"status.changed" (reserved) event raised', !!evRes && evRes.payload.from === 'pending', evRes);
  check('coach recorded on the need', (await needOf(`${A}:registration`)).coachId === 'coach_thabo_nkosi');
  const a3 = await searchReady(A);
  await select(a3.tx, A);
  check('a new request for a reserved need is rejected', (await waitStatus(a3.tx, 'rejected')) === 'rejected');

  // ------------------------------------------------------------------
  section('10. Confirm and completion');
  r = await api('POST', '/v1/confirm', { transactionId: a1.tx, note: 'Documents reviewed' });
  check('confirm accepted', r.status === 202 && r.body.status === 'confirming', r);
  const evConf = await waitEvent(a1.tx, 'request.received', (e) => e.payload.stage === 'confirm');
  check('"request.received" (confirm) event raised', !!evConf, evConf);
  r = await api('POST', '/v1/provider/complete', { transactionId: a1.tx });
  check('WeHelp marks it complete', r.status === 200 && r.body.needStatus === 'fulfilled', r);
  check('Naledi\'s side shows fulfilled', (await waitStatus(a1.tx, 'fulfilled')) === 'fulfilled');
  const evFul = await waitEvent(a1.tx, 'status.changed', (e) => e.status === 'fulfilled');
  check('"status.changed" (fulfilled) event raised', !!evFul);
  r = await api('POST', '/v1/confirm', { transactionId: a1.tx });
  check('confirming again is idempotent (200)', r.status === 200 && r.body.idempotent === true, r);
  const a4 = await searchReady(A);
  await select(a4.tx, A);
  check('a fulfilled need cannot be requested again', (await waitStatus(a4.tx, 'rejected')) === 'rejected');

  // ------------------------------------------------------------------
  section('11. Decline, then retry');
  const D = 'prac_e2e_d';
  const d1 = await searchReady(D);
  await select(d1.tx, D);
  await waitEvent(d1.tx, 'request.received');
  r = await api('POST', '/v1/provider/decision', { transactionId: d1.tx, decision: 'decline' });
  check('decline accepted, need reopened', r.status === 200 && r.body.needStatus === 'open', r);
  check('Naledi\'s side shows rejected', (await waitStatus(d1.tx, 'rejected')) === 'rejected');
  const d2 = await searchReady(D);
  await select(d2.tx, D);
  await waitEvent(d2.tx, 'request.received');
  r = await api('POST', '/v1/provider/decision', { transactionId: d2.tx, decision: 'accept' });
  check('after a decline the same need can be requested and accepted again', r.status === 200 && (await waitStatus(d2.tx, 'reserved')) === 'reserved', r);

  // ------------------------------------------------------------------
  section('12. Two requests for the same need at the same instant');
  const E = 'prac_e2e_e';
  const [e1, e2] = await Promise.all([searchReady(E), searchReady(E)]);
  await Promise.all([select(e1.tx, E), select(e2.tx, E)]);
  await sleep(3000);
  const stE = [(await statusOf(e1.tx)).status, (await statusOf(e2.tx)).status].sort();
  check('exactly one is pending and one is rejected', stE[0] === 'pending' && stE[1] === 'rejected', stE);
  pend = await pendingFor(`${E}:registration`);
  const winner = (await statusOf(e1.tx)).status === 'pending' ? e1.tx : e2.tx;
  check('the queued request belongs to the transaction that won (no mix-up)', pend.length === 1 && pend[0].action === 'init' && pend[0].context.transactionId === winner, pend.map((p) => [p.action, p.context.transactionId]));
  await api('POST', '/v1/provider/decision', { transactionId: winner, decision: 'decline' });

  // ------------------------------------------------------------------
  section('13. Restart both apps in the middle of a request');
  const F = 'prac_e2e_f';
  const f1 = await searchReady(F);
  await select(f1.tx, F);
  await waitEvent(f1.tx, 'request.received');
  const epochBefore = (await api('GET', '/v1/health', null, null)).body.epoch;
  docker(['restart', 'sandbox-bap', 'sandbox-bpp']);
  check('both apps come back healthy', !!(await waitHealthy()));
  check('epoch unchanged by the restart', (await api('GET', '/v1/health', null, null)).body.epoch === epochBefore);
  const stF = await statusOf(f1.tx);
  check('Naledi\'s transaction survived the restart (still pending)', stF.status === 'pending' && stF.practitionerId === F, stF);
  pend = await pendingFor(`${F}:registration`);
  check('WeHelp\'s pending request survived the restart', pend.length === 1 && pend[0].context.transactionId === f1.tx);
  r = await api('POST', '/v1/provider/decision', { transactionId: f1.tx, decision: 'accept' });
  check('a decision after the restart still completes the flow', r.status === 200 && (await waitStatus(f1.tx, 'reserved')) === 'reserved', r);

  // ------------------------------------------------------------------
  if (DELEGATED) {
    section('14. Partner webhook: delivery, retry, outage, restart');
    const G = 'prac_e2e_g';
    const g1 = await searchReady(G);
    const mEvents = async () => (await mock('GET', '/mock/events')).body;
    const mockHas = (tx, name) => waitFor(async () => (await mEvents()).events.find((e) => e.transactionId === tx && e.event === name), 40000, 500);

    check('every event so far reached the partner exactly once (no duplicates)', await (async () => {
      const ev = (await mEvents()).events;
      return new Set(ev.map((e) => e.eventId)).size === ev.length && ev.length > 0;
    })());
    check('"practitioner.matched" reached the partner', !!(await mockHas(g1.tx, 'practitioner.matched')));

    const before = (await mEvents()).attempts;
    await mock('POST', '/mock/config', { failNext: 3 });
    await api('POST', '/v1/provider/offer', { transactionId: g1.tx, providerId: 'provider-wehelp', title: 'Offer during simulated failures' });
    const got = await mockHas(g1.tx, 'offer.received');
    const after = (await mEvents()).attempts;
    check('event delivered after 3 simulated failures (retry with backoff)', !!got && after - before >= 4, { attemptsUsed: after - before });
    const dupCheck = (await mEvents()).events.filter((e) => e.event === 'offer.received' && e.transactionId === g1.tx);
    check('and delivered only once', dupCheck.length === 1, dupCheck.length);

    await mock('POST', '/mock/config', { down: true });
    await api('POST', '/v1/provider/offer', { transactionId: g1.tx, providerId: 'provider-wehelp', title: 'Offer while partner is DOWN', offerId: 'offer-down-1' });
    await sleep(2500);
    const health = (await api('GET', '/v1/health', null, null)).body;
    check('while the partner is down the event waits in the outbox', health.outboxPending >= 1, health);
    docker(['restart', 'sandbox-bap']);
    await waitHealthy();
    const health2 = (await api('GET', '/v1/health', null, null)).body;
    check('the waiting event survived a restart of the app', health2.outboxPending >= 1, health2);
    await mock('POST', '/mock/config', { down: false });
    const late = await waitFor(async () => (await mEvents()).events.find((e) => e.event === 'offer.received' && e.payload && e.payload.offerId === 'offer-down-1'), 45000, 500);
    check('once the partner is back, the event is delivered', !!late);

    section('15. Partner too slow to answer the match lookup');
    await mock('POST', '/mock/config', { matchDelayMs: 4500 });
    const t1 = Date.now();
    const h1 = await searchReady('prac_e2e_h');
    const took = Date.now() - t1;
    await mock('POST', '/mock/config', { matchDelayMs: 0 });
    check('search still completes (fallback: no matches) within the timeout', h1.ready && ((await api('GET', `/v1/results/${h1.tx}`)).body.results || []).length === 0 && took < 8000, { ms: took });
    const meta = ((await bppState()).txMeta || {})[h1.tx];
    check('the failed lookup is recorded on the search', !!meta && !!meta.matchError, meta && meta.matchError);
  }

  // ------------------------------------------------------------------
  section('16. The built-in Naledi/provider pages still work');
  let g = await call(BAP, 'GET', '/', null, {});
  check('Naledi front door page (3001) loads', g.status === 200);
  g = await call(BAP, 'GET', '/live', null, {});
  check('split view (/live) loads', g.status === 200);
  g = await call(BPP, 'GET', '/', null, {});
  check('provider console page (3002) loads', g.status === 200);
  await api('POST', '/v1/admin/reset'); // fresh seed for the legacy checks
  r = await call(BAP, 'POST', '/api/trigger/discover', { needType: 'registration', region: 'Gauteng' }, {});
  const legacyDisc = await waitFor(async () => {
    const s = (await call(BAP, 'GET', '/api/state', null, {})).body;
    return s.lastDiscoverResult;
  });
  check('legacy discover returns a result', !!legacyDisc);
  if (!DELEGATED) check('legacy discover finds providers (incl. WeHelp via Gauteng coverage)', legacyDisc && legacyDisc.providers.length >= 3 && legacyDisc.providers.some((p) => p.id === 'provider-wehelp'), legacyDisc && legacyDisc.providers.map((p) => p.id));
  const state0 = (await call(BAP, 'GET', '/api/state', null, {})).body;
  const regNeed = state0.naledi.needs.find((n) => n.type === 'registration');
  check('built-in page: Naledi has needs for all 6 categories (peer guidance / infrastructure included)', state0.naledi.needs.length === 6, state0.naledi.needs.map((n) => n.type));
  await call(BAP, 'POST', '/api/trigger/select', { needId: regNeed.id, providerId: 'provider-wehelp' }, {});
  await call(BAP, 'POST', '/api/trigger/init', { needId: regNeed.id, providerId: 'provider-wehelp' }, {});
  const lp = await waitFor(async () => ((await call(BPP, 'GET', '/api/state', null, {})).body.pending || []).find((p) => p.needId === regNeed.id && p.action === 'init'));
  check('built-in page: request reaches the provider console queue', !!lp);
  if (lp) await call(BPP, 'POST', `/api/pending/${lp.id}/approve`, null, {});
  const reserved = await waitFor(async () => ((await call(BAP, 'GET', '/api/state', null, {})).body.naledi.needs.find((n) => n.id === regNeed.id) || {}).status === 'reserved');
  check('built-in page: approve reserves the need', !!reserved);
  await call(BAP, 'POST', '/api/trigger/confirm', { needId: regNeed.id, providerId: 'provider-wehelp', note: 'done' }, {});
  const lc = await waitFor(async () => ((await call(BPP, 'GET', '/api/state', null, {})).body.pending || []).find((p) => p.needId === regNeed.id && p.action === 'confirm'));
  if (lc) await call(BPP, 'POST', `/api/pending/${lc.id}/approve`, null, {});
  const fulfilled = await waitFor(async () => ((await call(BAP, 'GET', '/api/state', null, {})).body.naledi.needs.find((n) => n.id === regNeed.id) || {}).status === 'fulfilled');
  check('built-in page: confirm + approve fulfils the need', !!fulfilled);

  // ------------------------------------------------------------------
  section('16b. The internet-facing edge (port 3010) exposes /v1 and nothing else');
  const EDGE = process.env.EDGE || 'http://localhost:3010';
  r = await call(EDGE, 'GET', '/v1/health', null, {});
  check('/v1/health works through the edge', r.status === 200 && r.body.ok === true, r);
  r = await call(EDGE, 'POST', '/v1/search', { practitionerId: 'x', needType: 'registration' }, {});
  check('/v1/search through the edge without a key -> 401', r.status === 401, r.status);
  r = await call(EDGE, 'GET', '/v1/status/nope', null, { 'X-Api-Key': KEY });
  check('the key is passed through the edge (404 unknown transaction, not 401)', r.status === 404 && r.body.error === 'unknown_transaction', r);
  for (const [m, p] of [['GET', '/api/state'], ['POST', '/api/trigger/select'], ['POST', '/api/bap-webhook/on_init'], ['POST', '/bap/caller/discover'], ['GET', '/internal/state'], ['GET', '/live'], ['GET', '/']]) {
    const x = await call(EDGE, m, p, m === 'POST' ? {} : null, { 'X-Api-Key': KEY, 'x-internal-key': KEY });
    check(`edge blocks ${m} ${p}`, x.status === 404, x.status);
  }

  // ------------------------------------------------------------------
  section('17. Audit of the real ONIX adapters\' own logs (since the test began)');
  const bapLog = docker(['logs', 'onix-bap', '--since', T0]);
  const bppLog = docker(['logs', 'onix-bpp', '--since', T0]);
  const both = `${bapLog}\n${bppLog}`;
  const errLines = both.split('\n').filter((l) => l.includes('"level":"error"'));
  check('no error-level lines in either adapter', errLines.length === 0, errLines.slice(0, 2));
  // Real failures only: the adapters also log "... validation passed" at debug level.
  const schemaProblems = both
    .split('\n')
    .filter((l) => !/passed/i.test(l) && /is unsupported|validation (failed|error)|"NACK"|invalid signature|signature (validation )?failed|schema.{0,40}(failed|invalid)/i.test(l));
  check('no schema rejections, NACKs or validation failures', schemaProblems.length === 0, schemaProblems.slice(0, 2).map((l) => l.slice(0, 200)));
  const hosts = new Set([...both.matchAll(/Forwarding request to URL: (https?:\/\/[^/"\s]+)/g)].map((m) => m[1]));
  const allowed = new Set(['http://onix-bpp:8082', 'http://onix-bap:8081', 'http://sandbox-bap:3001', 'http://sandbox-bpp:3002']);
  check('every message was forwarded inside our own network only', hosts.size > 0 && [...hosts].every((h) => allowed.has(h)), [...hosts]);
  for (const action of ['discover', 'on_discover', 'select', 'init', 'on_init', 'confirm', 'on_confirm']) {
    const found = both.split('\n').some((l) => l.includes(a1.tx) && l.includes(`action=\\"${action}\\"`));
    check(`adapter logs show "${action}" for Naledi's transaction`, found);
  }
  const rc = docker(['inspect', '-f', '{{.RestartCount}}', 'onix-bap', 'onix-bpp']).trim().split(/\s+/);
  check('the ONIX adapters never restarted', rc.every((x) => x === '0'), rc);

  // ------------------------------------------------------------------
  section('18. Clean up');
  r = await api('POST', '/v1/admin/reset');
  check('final reset', r.status === 200 && r.body.providerSide === 'ok', r);
  if (DELEGATED) await mock('POST', '/mock/reset');

  console.log(`\n==== ${passed} passed, ${failures.length} failed ====`);
  if (failures.length) {
    console.log('Failed checks:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
})().catch((e) => {
  console.error('\nTEST RUN CRASHED:', e);
  process.exit(2);
});
