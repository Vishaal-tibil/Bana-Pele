// uc2-live.js -- every UC2 API, end to end, against a running network whose
// matching comes from the partner (coordination-service), e.g. on Azure.
//
//   API_KEY=<key> BAP=https://<network> node tests/uc2-live.js
//
// It creates one practitioner of its own (prac_uc2live_<time>), plays both
// Naledi and the Thabos, and withdraws its request at the end. The partner
// receives the usual events for it. Needs at least two results for the search.
// Whether the partner already returns individual Thabos is reported, not
// required (organisations work the same way through these APIs).

'use strict';

const BAP = (process.env.BAP || 'http://localhost:3010').replace(/\/+$/, '');
const KEY = process.env.API_KEY || '';
const NEED = process.env.NEED_TYPE || 'nutrition';
const REGION = process.env.REGION || 'Gauteng';
const ROLES = (process.env.ROLES || 'nutrition_specialist').split(',').map((r) => r.trim()).filter(Boolean);
const LANGUAGE = process.env.LANGUAGE || 'zu';
const P = `prac_uc2live_${Date.now().toString(36)}`;

let passed = 0;
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function section(t) { console.log(`\n== ${t}`); }
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 400) : ''}`); }
}
function info(t) { console.log(`  info  ${t}`); }
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
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(500); }
  return null;
}
const status = async (tx) => (await api('GET', `/v1/status/${tx}`)).body.status;
const row = async () => ((await api('GET', `/v1/commitments?practitionerId=${P}&needType=${NEED}`)).body.commitments || [])[0];
const day = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

(async () => {
  if (!KEY) { console.log('Set API_KEY (and BAP).'); process.exit(2); }
  console.log(`network: ${BAP}\npractitioner: ${P}`);
  const h = (await api('GET', '/v1/health')).body;
  check('network is up', h.ok === true, h);

  section('1. search: checks on the new fields');
  const base = { practitionerId: P, needType: NEED, region: REGION };
  check('unknown deliveryMode -> 400', (await api('POST', '/v1/search', { ...base, deliveryMode: 'teleport' })).status === 400);
  check('unknown urgency -> 400', (await api('POST', '/v1/search', { ...base, urgency: 'yesterday' })).status === 400);
  check('role that is not a code -> 400', (await api('POST', '/v1/search', { ...base, roles: ['Social Worker'] })).status === 400);
  check('exclusion without userId -> 400', (await api('POST', '/v1/search', { ...base, excludeThaboRefs: [{ app: 'elevate' }] })).status === 400);

  section('2. search with preferences -> results');
  const s = await api('POST', '/v1/search', { ...base, language: LANGUAGE, deliveryMode: 'either', urgency: 'high', roles: ROLES, excludeThaboRefs: [{ app: 'elevate', userId: 'u-already' }] });
  check('search -> 202', s.status === 202, s);
  const tx = s.body.transactionId;
  const res = await until(async () => { const r = (await api('GET', `/v1/results/${tx}`)).body; return r.status === 'results_ready' ? r : null; });
  const results = (res && res.results) || [];
  check('results arrived', results.length > 0, res);
  const st = (await api('GET', `/v1/status/${tx}`)).body;
  check('the request keeps the preferences', st.language === LANGUAGE && st.deliveryMode === 'either' && st.urgency === 'high' && JSON.stringify(st.roles) === JSON.stringify(ROLES), st);
  const thabos = results.filter((r) => r.kind === 'thabo');
  info(`${results.length} results, ${thabos.length} individual Thabos${thabos[0] ? ` (first: ${thabos[0].name}, ${thabos[0].role}, thaboRef ${JSON.stringify(thabos[0].thaboRef)})` : ' -- coordination still returns organisations'}`);
  if (results.length < 2) { console.log('\nNeed at least two results to go on.'); process.exit(1); }
  const [first, second] = results;

  section('3. select with shared context');
  const sel = (providerId, sharedContext) => api('POST', '/v1/select', { transactionId: tx, practitionerId: P, needType: NEED, providerId, sharedContext });
  check('context not an object -> 400', (await sel(first.providerId, 'all of it')).status === 400);
  check('context over 4000 characters -> 400', (await sel(first.providerId, { notes: 'x'.repeat(5000) })).status === 400);
  const ctx = { elpRegistrationStatus: 'in progress', preferredContact: 'whatsapp' };
  const s1 = await sel(first.providerId, ctx);
  check('select -> 202 pending', s1.status === 202 && s1.body.status === 'pending', s1);
  const r1 = await until(async () => { const c = await row(); return c && c.sharedContext ? c : null; });
  check('the context is held for that provider only', r1 && r1.sharedContext.providerId === first.providerId && JSON.stringify(r1.sharedContext.context) === JSON.stringify(ctx), r1 && r1.sharedContext);

  section('4. decline, then pick another on the same request');
  const d1 = await api('POST', '/v1/provider/decision', { transactionId: tx, decision: 'decline' });
  check('provider declines -> 200', d1.status === 200, d1);
  check('status -> rejected', !!(await until(async () => (await status(tx)) === 'rejected')));
  const r2 = await row();
  check('the declining provider keeps no context', r2 && r2.sharedContext === null, r2 && r2.sharedContext);
  const s2 = await sel(second.providerId, { preferredContact: 'phone' });
  check('select another provider on the same transaction -> 202', s2.status === 202, s2);
  const r3 = await until(async () => { const c = await row(); return c && c.sharedContext && c.sharedContext.providerId === second.providerId ? c : null; });
  check('only the new context, for the new provider', r3 && JSON.stringify(r3.sharedContext.context) === '{"preferredContact":"phone"}', r3 && r3.sharedContext);

  section('5. referral');
  check('refer to themselves -> 400', (await api('POST', '/v1/provider/refer', { transactionId: tx, referTo: { providerId: second.providerId } })).status === 400);
  const ref = await api('POST', '/v1/provider/refer', { transactionId: tx, referTo: { providerId: first.providerId }, note: 'Better placed for this' });
  check('provider refers -> 200', ref.status === 200 && ref.body.declined === second.providerId, ref);
  check('the referring provider\'s request is declined', !!(await until(async () => (await status(tx)) === 'rejected')));
  const rr = await until(async () => { const r = (await api('GET', `/v1/results/${tx}`)).body; return (r.referrals || []).length ? r : null; });
  check('the referral reaches her request', rr && rr.referrals[0].fromProviderId === second.providerId && rr.referrals[0].referTo.providerId === first.providerId, rr && rr.referrals);
  check('the referred provider is marked in her results', rr && rr.results.some((r) => r.providerId === first.providerId && r.referredBy === second.providerId));
  const ev = (await api('GET', '/v1/events')).body;
  check('a referral.received event was sent', (Array.isArray(ev) ? ev : ev.events || []).some((e) => e.event === 'referral.received' && e.transactionId === tx));
  const s3 = await sel(first.providerId, ctx);
  check('she accepts the referral by selecting them -> 202', s3.status === 202, s3);
  const d2 = await api('POST', '/v1/provider/decision', { transactionId: tx, decision: 'accept' });
  check('referred provider accepts -> 200', d2.status === 200, d2);
  check('status -> reserved', !!(await until(async () => (await status(tx)) === 'reserved')));

  section('6. contributions');
  const con = (b) => api('POST', '/v1/provider/contribution', { transactionId: tx, ...b });
  check('unknown type -> 400', (await con({ type: 'gossip', summary: 'x' })).status === 400);
  check('no summary -> 400', (await con({ type: 'support_provided' })).status === 400);
  check('follow_up without date -> 400', (await con({ type: 'follow_up', summary: 'x' })).status === 400);
  check('new_need without need type -> 400', (await con({ type: 'new_need', summary: 'x' })).status === 400);
  check('a provider not holding it -> 409', (await con({ type: 'support_provided', summary: 'x', providerId: 'provider-not-me' })).status === 409);
  const made = [
    await con({ type: 'support_provided', summary: 'Planning session', details: 'Reviewed the weekly menu' }),
    await con({ type: 'agreed_action', summary: 'Costed five-day meal plan', dueDate: day(14) }),
    await con({ type: 'follow_up', summary: 'Observation visit', dueDate: day(7) }),
    await con({ type: 'milestone', summary: 'Menu agreed' }),
    await con({ type: 'status_update', summary: 'On track' }),
    await con({ type: 'evidence', summary: 'Menu and purchasing list', evidenceRef: 'elevate://evidence/123' }),
    await con({ type: 'new_need', summary: 'Food-preparation hygiene', newNeedType: 'health-safety' }),
  ];
  check('all seven types recorded -> 201', made.every((r) => r.status === 201), made.map((r) => r.status));
  const r4 = await row();
  check('they show in the shared view', r4 && (r4.contributions || []).length === 7, r4 && (r4.contributions || []).map((c) => c.type));
  check('nextFollowUp is the earliest upcoming date', r4 && r4.nextFollowUp === day(7), r4 && r4.nextFollowUp);

  section('7. revoke shared context');
  const rv = await api('POST', '/v1/consent/revoke', { transactionId: tx });
  check('revoke -> revoked', rv.status === 200 && rv.body.revoked === true, rv);
  const r5 = await row();
  check('context gone, request still held', r5 && r5.sharedContext === null && r5.status === 'reserved', r5 && { sharedContext: r5.sharedContext, status: r5.status });
  const rv2 = await api('POST', '/v1/consent/revoke', { transactionId: tx });
  check('revoke again -> revoked: false', rv2.status === 200 && rv2.body.revoked === false, rv2);

  section('8. status check and withdraw');
  const rf = await api('POST', `/v1/status/${tx}/refresh`);
  check('status refresh -> 202', rf.status === 202, rf);
  await sleep(2000);
  check('still reserved after the check', (await status(tx)) === 'reserved');
  const w = await api('POST', '/v1/withdraw', { transactionId: tx });
  check('withdraw -> 202', w.status === 202, w);
  check('status -> withdrawn', !!(await until(async () => (await status(tx)) === 'withdrawn')));

  console.log(`\n==== ${passed} passed, ${failures.length} failed ====`);
  if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
