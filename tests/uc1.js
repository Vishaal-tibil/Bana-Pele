// uc1.js -- checks the two UC1 features: the per-Naledi shared view
// (GET /v1/commitments) and NGO subscriptions (/v1/subscriptions).
//
//   API_KEY=<key> node tests/uc1.js
//
// It runs its own small webhook receiver (two pretend NGOs) and subscribes
// them. sandbox-bpp must be able to reach that receiver:
//   - stack in Docker on this machine: the default, http://host.docker.internal:<port>
//   - apps running directly on this machine: SUB_HOST=http://127.0.0.1
// Needs the stack running (bash start.sh).

'use strict';

const http = require('http');

const BAP = process.env.BAP || 'http://localhost:3001';
const KEY = process.env.API_KEY || 'demo-key-change-me';
const PORT = Number(process.env.SUB_PORT || 3077);
const SUB_HOST = process.env.SUB_HOST || 'http://host.docker.internal';
const P = `prac_uc1_${Date.now().toString(36)}`;

let passed = 0;
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function section(t) { console.log(`\n== ${t}`); }
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 300) : ''}`); }
}
async function api(method, path, body, key = KEY) {
  const res = await fetch(BAP + path, {
    method,
    headers: { ...(key ? { 'X-Api-Key': key } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
  return { status: res.status, body: json };
}
async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(250); }
}

// ---- the pretend NGOs ----
const got = { wehelp: [], nutrition: [] };
const keys = { wehelp: 'wehelp-secret-' + Date.now(), nutrition: null };
let failFirst = 1; // the WeHelp receiver refuses its first delivery, to prove the retry
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const who = req.url.includes('wehelp') ? 'wehelp' : 'nutrition';
    if (who === 'wehelp' && failFirst > 0) { failFirst -= 1; res.writeHead(503); return res.end(); }
    let evt = {}; try { evt = JSON.parse(b); } catch (e) {}
    got[who].push({ key: req.headers['x-api-key'], evt });
    res.writeHead(204); res.end();
  });
});

(async () => {
  await new Promise((r) => server.listen(PORT, '0.0.0.0', r));

  section('1. Security');
  let r = await api('GET', '/v1/commitments', null, null);
  check('commitments without a key -> 401', r.status === 401, r.status);
  r = await api('POST', '/v1/subscriptions', { url: 'http://x' }, 'wrong');
  check('subscribe with a wrong key -> 401', r.status === 401, r.status);
  r = await api('POST', '/v1/subscriptions', { url: 'ftp://nope' });
  check('subscribe with a non-http url -> 400', r.status === 400, r);
  r = await api('POST', '/v1/subscriptions', { url: 'http://x', events: ['bogus'] });
  check('subscribe with an unknown event -> 400', r.status === 400, r);

  section('2. Two NGOs subscribe');
  r = await api('POST', '/v1/subscriptions', {
    name: 'WeHelp portal', url: `${SUB_HOST}:${PORT}/wehelp`, secret: keys.wehelp,
    providerIds: ['provider-wehelp'], needTypes: ['registration'],
    events: ['practitioner.matched', 'request.received', 'status.changed'],
  });
  const subA = r.body;
  check('WeHelp subscription created (201) and its secret returned once', r.status === 201 && subA.secret === keys.wehelp && subA.id, r);
  r = await api('POST', '/v1/subscriptions', { name: 'Nutrition NGO', url: `${SUB_HOST}:${PORT}/nutrition`, needTypes: ['nutrition'] });
  const subB = r.body;
  keys.nutrition = subB.secret;
  check('second subscription gets a generated secret', r.status === 201 && typeof subB.secret === 'string' && subB.secret.length >= 32, r);
  r = await api('GET', '/v1/subscriptions');
  const listed = Array.isArray(r.body) ? r.body : [];
  check('list shows both subscriptions', [subA.id, subB.id].every((id) => listed.some((x) => x.id === id)), r.body);
  check('list never shows a secret', listed.every((x) => x.secret === undefined), listed);

  section('3. A new Naledi matches: WeHelp is told');
  r = await api('POST', '/v1/search', { practitionerId: P, needType: 'registration', region: 'Alexandra', tier: 'Pre-Bronze', children: 20, title: 'Register my ECD', description: 'Help submitting DSD registration documents' });
  const tx = r.body.transactionId;
  check('search accepted', r.status === 202 && tx, r);
  const matched = await waitFor(() => got.wehelp.find((x) => x.evt.event === 'practitioner.matched' && x.evt.transactionId === tx), 15000);
  check('WeHelp received practitioner.matched (after one failed delivery, retried)', !!matched, got.wehelp.map((x) => x.evt.event));
  check('delivery carries the subscription secret in X-Api-Key', matched && matched.key === keys.wehelp, matched && matched.key);
  check('event names the practitioner, need type and region', matched && matched.evt.practitionerId === P && matched.evt.payload.needType === 'registration' && matched.evt.payload.region === 'Alexandra', matched && matched.evt);

  section('4. Naledi asks for WeHelp: request.received');
  r = await api('POST', '/v1/select', { transactionId: tx, practitionerId: P, needType: 'registration', providerId: 'provider-wehelp' });
  check('select accepted', r.status === 202, r);
  const reqd = await waitFor(() => got.wehelp.find((x) => x.evt.event === 'request.received' && x.evt.transactionId === tx));
  check('WeHelp received request.received', !!reqd, got.wehelp.map((x) => x.evt.event));

  section('5. Shared view while waiting');
  let c = await waitFor(async () => {
    const x = await api('GET', `/v1/commitments?practitionerId=${P}`);
    const it = (x.body.commitments || []).find((n) => n.needType === 'registration');
    return it && it.awaitingDecision ? it : null;
  });
  check('commitment shows status open, awaiting WeHelp\'s decision', c && c.status === 'open' && c.awaitingDecision.providerId === 'provider-wehelp', c);

  section('6. WeHelp accepts: the need is reserved for everyone to see');
  r = await api('POST', '/v1/provider/decision', { transactionId: tx, decision: 'accept', coachId: 'coach_uc1' });
  check('decision accepted', r.status === 200 && r.body.needStatus === 'reserved', r);
  c = (await api('GET', `/v1/commitments?practitionerId=${P}`)).body.commitments.find((n) => n.needType === 'registration');
  check('commitment: reserved by WeHelp, coach and transaction recorded', c && c.status === 'reserved' && c.providerId === 'provider-wehelp' && c.providerName === 'WeHelp' && c.coachId === 'coach_uc1' && c.transactionId === tx, c);
  const st = await waitFor(() => got.wehelp.find((x) => x.evt.event === 'status.changed' && x.evt.status === 'reserved' && x.evt.transactionId === tx));
  check('WeHelp received status.changed (reserved)', !!st, got.wehelp.map((x) => `${x.evt.event}:${x.evt.status}`));
  r = await api('GET', '/v1/commitments?status=reserved&providerId=provider-wehelp');
  check('filter by status and provider works', r.status === 200 && r.body.commitments.some((n) => n.practitionerId === P), r.body.count);
  r = await api('GET', '/v1/commitments?coachId=coach_uc1');
  check('filter by coach works (coach app view)', r.status === 200 && r.body.commitments.length >= 1 && r.body.commitments.every((n) => n.coachId === 'coach_uc1'), r.body);
  r = await api('GET', `/v1/transactions?practitionerId=${P}`);
  check('transactions filtered by practitioner (Naledi app view)', r.status === 200 && r.body.length === 1 && r.body[0].transactionId === tx, r.body);

  section('7. Confirm and complete');
  // confirm needs Naledi's side to have received the provider's acceptance (on_init) first
  await waitFor(async () => (await api('GET', `/v1/status/${tx}`)).body.status === 'reserved');
  r = await api('POST', '/v1/confirm', { transactionId: tx });
  check('confirm accepted', r.status === 202, r);
  r = await api('POST', '/v1/provider/complete', { transactionId: tx });
  check('complete accepted', r.status === 200 && r.body.needStatus === 'fulfilled', r);
  c = (await api('GET', `/v1/commitments?practitionerId=${P}`)).body.commitments.find((n) => n.needType === 'registration');
  check('commitment: fulfilled', c && c.status === 'fulfilled', c);
  check('commitment keeps the practitioner id exactly as sent', c && c.practitionerId === P, c && c.practitionerId);
  check('commitment carries title, description and createdAt from the search', c && c.title === 'Register my ECD' && c.description === 'Help submitting DSD registration documents' && !!c.createdAt, c);
  check('commitment has completedAt once fulfilled', c && !!c.completedAt && c.completedAt >= c.createdAt, c && c.completedAt);
  const evs = (c && c.history || []).map((h) => h.event);
  check('history: requested, accepted, confirm_requested, fulfilled (timestamped)', JSON.stringify(evs) === JSON.stringify(['requested', 'accepted', 'confirm_requested', 'fulfilled']) && c.history.every((h) => h.at), evs);
  r = await api('GET', `/v1/transactions?practitionerId=${P}`);
  check('Naledi side also returns the title', r.body[0] && r.body[0].title === 'Register my ECD', r.body[0]);

  section('7b. Decline, then withdraw');
  const P2 = P + '_d';
  const ask = async (who) => {
    const s1 = await api('POST', '/v1/search', { practitionerId: P2, needType: 'registration', region: 'Alexandra', title: 'Second ask' });
    await waitFor(async () => (await api('GET', `/v1/status/${s1.body.transactionId}`)).body.status === 'results_ready');
    await api('POST', '/v1/select', { transactionId: s1.body.transactionId, practitionerId: P2, needType: 'registration', providerId: who });
    await waitFor(async () => {
      const x = await api('GET', `/v1/commitments?practitionerId=${P2}`);
      return (x.body.commitments || []).some((n) => n.awaitingDecision && n.awaitingDecision.transactionId === s1.body.transactionId);
    });
    return s1.body.transactionId;
  };
  const txD = await ask('provider-wehelp');
  r = await api('POST', '/v1/provider/decision', { transactionId: txD, decision: 'decline' });
  check('provider declines', r.status === 200 && r.body.needStatus === 'open', r.body);
  c = (await api('GET', `/v1/commitments?practitionerId=${P2}`)).body.commitments[0];
  check('after a decline the need is open again, nobody holds it', c && c.status === 'open' && !c.providerId && !c.awaitingDecision, c);
  check('history records the decline and who declined', c && c.history.some((h) => h.event === 'declined' && h.providerId === 'provider-wehelp' && h.at), c && c.history);
  check('Naledi side sees rejected (and may ask someone else)', (await waitFor(async () => (await api('GET', `/v1/status/${txD}`)).body.status === 'rejected')) === true);

  const txW = await ask('provider-wehelp');
  r = await api('POST', '/v1/withdraw', { transactionId: txW, reason: 'no longer needed' });
  check('withdraw while waiting for the provider -> 202', r.status === 202 && r.body.status === 'withdrawing', r);
  check('Naledi side becomes withdrawn', (await waitFor(async () => (await api('GET', `/v1/status/${txW}`)).body.status === 'withdrawn')) === true);
  c = (await api('GET', `/v1/commitments?practitionerId=${P2}`)).body.commitments[0];
  check('need is withdrawn, with no waiting request left', c && c.status === 'withdrawn' && !c.awaitingDecision, c);
  r = await api('POST', '/v1/provider/decision', { transactionId: txW, decision: 'accept', coachId: 'coach_x' });
  check('the provider can no longer accept a withdrawn request', r.status === 404, r);

  const txR = await ask('provider-wehelp');
  c = (await api('GET', `/v1/commitments?practitionerId=${P2}`)).body.commitments[0];
  check('asking again after withdrawing re-opens the need', c && c.status === 'open' && c.awaitingDecision, c);
  await api('POST', '/v1/provider/decision', { transactionId: txR, decision: 'accept', coachId: 'coach_x' });
  await waitFor(async () => (await api('GET', `/v1/status/${txR}`)).body.status === 'reserved');
  r = await api('POST', '/v1/withdraw', { transactionId: txR });
  await waitFor(async () => (await api('GET', `/v1/status/${txR}`)).body.status === 'withdrawn');
  c = (await api('GET', `/v1/commitments?practitionerId=${P2}`)).body.commitments[0];
  check('withdraw after the provider accepted releases the provider and coach', c && c.status === 'withdrawn' && !c.providerId && !c.coachId, c);
  r = await api('POST', '/v1/withdraw', { transactionId: tx });
  check('a delivered request cannot be withdrawn (409)', r.status === 409 && r.body.error === 'already_fulfilled', r);

  section('8. Filters: the nutrition NGO heard nothing');
  await sleep(1500);
  check('nutrition subscriber received no events for a registration need', got.nutrition.length === 0, got.nutrition.map((x) => x.evt.event));
  const dupes = got.wehelp.length - new Set(got.wehelp.map((x) => x.evt.eventId)).size;
  check('no event delivered twice to WeHelp', dupes === 0, dupes);

  section('9. Unsubscribe');
  r = await api('DELETE', `/v1/subscriptions/${subA.id}`);
  check('delete subscription', r.status === 200 && r.body.deleted === true, r);
  r = await api('DELETE', `/v1/subscriptions/${subB.id}`);
  r = await api('DELETE', `/v1/subscriptions/${subB.id}`);
  check('deleting again -> 404', r.status === 404, r);
  const before = got.wehelp.length;
  await api('POST', '/v1/search', { practitionerId: P + '_2', needType: 'registration', region: 'Alexandra' });
  await sleep(3000);
  check('after unsubscribing, WeHelp is not told about new matches', got.wehelp.length === before, got.wehelp.length - before);

  server.close();
  console.log(`\n==== ${passed} passed, ${failures.length} failed ====`);
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error('\nTEST RUN CRASHED:', e); server.close(); process.exit(2); });
