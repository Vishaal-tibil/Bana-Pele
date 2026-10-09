// uc2.js -- checks UC2 "Naledi discovers the right Thabo for each need":
// search preferences (language, deliveryMode, urgency), individual Thabo
// profiles in the results, and Naledi's context going only to the Thabo she
// selects.
//
//   API_KEY=<key> node tests/uc2.js
//
// Two modes, depending on how sandox-bpp was started:
//   - no MATCH_URL (local matching): registers two Thabos and checks the
//     language / delivery-mode filtering.
//   - MATCH_URL=http://<this machine>:3079/match (PARTNER=1): this script plays
//     coordination-service's /network/match, and checks that the preferences
//     reach it and the Thabo profiles come back unchanged, in its order.

'use strict';

const http = require('http');

const BAP = process.env.BAP || 'http://localhost:3001';
const KEY = process.env.API_KEY || 'demo-key-change-me';
const PARTNER = process.env.PARTNER === '1';
const PARTNER_PORT = Number(process.env.PARTNER_PORT || 3079);
const RUN = Date.now().toString(36);
const P = `prac_uc2_${RUN}`;
// A region of its own, so seeded providers and earlier runs don't match.
const REGION = `UC2-Test-${RUN}`;

let passed = 0;
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function section(t) { console.log(`\n== ${t}`); }
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 400) : ''}`); }
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
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); }
  return null;
}
async function search(body) {
  const s = await api('POST', '/v1/search', { practitionerId: P, region: REGION, ...body });
  if (s.status !== 202) return { s };
  const tx = s.body.transactionId;
  const r = await until(async () => { const x = (await api('GET', `/v1/results/${tx}`)).body; return x.status === 'results_ready' ? x : null; });
  return { s, tx, results: (r && r.results) || [] };
}
const row = async (needType) => ((await api('GET', `/v1/commitments?practitionerId=${P}&needType=${needType}`)).body.commitments || [])[0];

// ---- partner mode: play /network/match ----
const THABOS = [
  { providerId: `thabo-zanele-${RUN}`, kind: 'thabo', name: 'Zanele', thaboRef: { app: 'elevate', userId: `u-zanele-${RUN}` }, role: 'nutrition_specialist', specialisation: ['nutrition_planning'],
    affiliation: { id: 'provider-impande', name: 'Impande' }, languages: ['en', 'zu'], verified: true, deliveryModes: ['in_person', 'remote'], availability: 'available',
    area: 'Soweto', regionsServed: ['Gauteng'], costOrFunding: 'funded', referralCapable: true, reasons: ['Speaks isiZulu'] },
  { providerId: `thabo-nomsa-${RUN}`, kind: 'thabo', name: 'Nomsa', thaboRef: { app: 'elevate', userId: `u-nomsa-${RUN}` }, role: 'peer_guide', specialisation: ['lived_experience'],
    affiliation: { id: 'community', name: 'Peer network' }, languages: ['zu'], verified: true, deliveryModes: ['in_person'], availability: 'limited',
    area: 'Soweto', regionsServed: ['Gauteng'], costOrFunding: 'free', referralCapable: false, reasons: ['Peer guide nearby'] },
];
let lastQuery = null;
let lastParams = null;
function startPartner() {
  return new Promise((resolve) => {
    http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      lastQuery = Object.fromEntries(u.searchParams);
      lastParams = u.searchParams;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ matches: u.searchParams.get('region') === REGION ? THABOS : [] }));
    }).listen(PARTNER_PORT, resolve);
  });
}

(async () => {
  section('search preferences are checked');
  const badMode = await api('POST', '/v1/search', { practitionerId: P, needType: 'nutrition', region: REGION, deliveryMode: 'teleport' });
  check('unknown deliveryMode -> 400', badMode.status === 400, badMode);
  const badUrg = await api('POST', '/v1/search', { practitionerId: P, needType: 'nutrition', region: REGION, urgency: 'yesterday' });
  check('unknown urgency -> 400', badUrg.status === 400, badUrg);
  const badRole = await api('POST', '/v1/search', { practitionerId: P, needType: 'nutrition', region: REGION, roles: ['Social Worker'] });
  check('a role that is not a code -> 400', badRole.status === 400, badRole);
  const badRef = await api('POST', '/v1/search', { practitionerId: P, needType: 'nutrition', region: REGION, excludeThaboRefs: [{ app: 'elevate' }] });
  check('an exclusion without userId -> 400', badRef.status === 400, badRef);

  let zanele, other;
  if (PARTNER) {
    section('partner matching (playing /network/match)');
    await startPartner();
    const a = await search({ needType: 'nutrition', language: 'zu', deliveryMode: 'in_person', urgency: 'high', roles: ['nutrition_specialist', 'peer_guide'], excludeThaboRefs: [{ app: 'elevate', userId: 'u-already' }] });
    check('search accepted', a.s.status === 202, a.s);
    check('language, deliveryMode and urgency reached the matcher', lastQuery && lastQuery.language === 'zu' && lastQuery.deliveryMode === 'in_person' && lastQuery.urgency === 'high', lastQuery);
    check('roles reached the matcher (repeated)', lastParams && lastParams.getAll('roles').join() === 'nutrition_specialist,peer_guide', lastParams && lastParams.getAll('roles'));
    check('exclusions reached the matcher as app:userId', lastParams && lastParams.getAll('excludeThaboRef').join() === 'elevate:u-already', lastParams && lastParams.getAll('excludeThaboRef'));
    check('both Thabos returned, in the matcher\'s order', a.results.map((r) => r.providerId).join() === THABOS.map((t) => t.providerId).join(), a.results.map((r) => r.providerId));
    const z = a.results[0] || {};
    const want = THABOS[0];
    check('the Thabo profile came through unchanged',
      z.kind === 'thabo' && z.role === want.role && z.verified === true && JSON.stringify(z.languages) === JSON.stringify(want.languages) &&
      JSON.stringify(z.affiliation) === JSON.stringify(want.affiliation) && JSON.stringify(z.deliveryModes) === JSON.stringify(want.deliveryModes) &&
      z.availability === 'available' && JSON.stringify(z.specialisation) === JSON.stringify(want.specialisation), z);
    check('thaboRef, area, regionsServed, costOrFunding, referralCapable and reasons came through',
      JSON.stringify(z.thaboRef) === JSON.stringify(want.thaboRef) && z.area === 'Soweto' && JSON.stringify(z.regionsServed) === '["Gauteng"]' &&
      z.costOrFunding === 'funded' && z.referralCapable === true && JSON.stringify(z.reasons) === JSON.stringify(want.reasons), z);
    const st = (await api('GET', `/v1/status/${a.tx}`)).body;
    check('the request keeps the preferences', st.language === 'zu' && st.deliveryMode === 'in_person' && st.urgency === 'high', st);
    zanele = { ...a, providerId: want.providerId };
    other = { ...a, providerId: THABOS[1].providerId };
  } else {
    section('local matching with Thabo profiles');
    const reg = async (b) => (await api('POST', '/v1/provider/register', { needTypesCovered: ['nutrition'], region: REGION, kind: 'thabo', verified: true, ...b })).body;
    const z = await reg({ name: 'Zanele', role: 'nutrition_specialist', languages: ['en', 'zu'], deliveryModes: ['in_person'], availability: 'available', affiliation: { id: 'provider-impande', name: 'Impande' },
      thaboRef: { app: 'elevate', userId: `u-zanele-${RUN}` }, costOrFunding: 'funded', referralCapable: true });
    const l = await reg({ name: 'Lerato', role: 'social_worker', languages: ['en'], deliveryModes: ['remote'], availability: 'limited', thaboRef: { app: 'elevate', userId: `u-lerato-${RUN}` } });
    check('two Thabos registered with profiles', !!z.id && !!l.id && z.role === 'nutrition_specialist' && JSON.stringify(l.deliveryModes) === '["remote"]' && z.thaboRef && z.thaboRef.app === 'elevate', { z, l });
    const zu = await search({ needType: 'nutrition', language: 'zu' });
    check('language zu -> only Zanele', zu.results.map((r) => r.providerId).join() === z.id, zu.results.map((r) => r.name));
    const zr = zu.results[0] || {};
    check('her profile is in the results', zr.role === 'nutrition_specialist' && zr.verified === true && zr.availability === 'available' && zr.affiliation && zr.affiliation.name === 'Impande' && zr.thaboRef && zr.costOrFunding === 'funded', zr);
    const sw = await search({ needType: 'nutrition', roles: ['social_worker'] });
    check('roles [social_worker] -> only Lerato', sw.results.map((r) => r.providerId).join() === l.id, sw.results.map((r) => r.name));
    const ex = await search({ needType: 'nutrition', excludeThaboRefs: [{ app: 'elevate', userId: `u-zanele-${RUN}` }] });
    check('excluding Zanele -> only Lerato', ex.results.map((r) => r.providerId).join() === l.id, ex.results.map((r) => r.name));
    const remote = await search({ needType: 'nutrition', deliveryMode: 'remote' });
    check('deliveryMode remote -> only Lerato', remote.results.map((r) => r.providerId).join() === l.id, remote.results.map((r) => r.name));
    const any = await search({ needType: 'nutrition', deliveryMode: 'either' });
    check('deliveryMode either -> both', any.results.length === 2, any.results.map((r) => r.name));
    zanele = { ...any, providerId: z.id };
    other = { ...any, providerId: l.id };
  }

  section('context goes only to the chosen Thabo');
  const ctx = { elpRegistrationStatus: 'in progress', identifiedNeeds: ['meal planning'], preferredContact: 'whatsapp' };
  const big = await api('POST', '/v1/select', { transactionId: zanele.tx, practitionerId: P, needType: 'nutrition', providerId: zanele.providerId, sharedContext: { notes: 'x'.repeat(5000) } });
  check('a context over 4000 characters -> 400', big.status === 400, big);
  const notObj = await api('POST', '/v1/select', { transactionId: zanele.tx, practitionerId: P, needType: 'nutrition', providerId: zanele.providerId, sharedContext: 'all of it' });
  check('a context that is not an object -> 400', notObj.status === 400, notObj);
  const sel = await api('POST', '/v1/select', { transactionId: zanele.tx, practitionerId: P, needType: 'nutrition', providerId: zanele.providerId, sharedContext: ctx });
  check('select with sharedContext -> 202', sel.status === 202, sel);
  const r1 = await until(async () => { const c = await row('nutrition'); return c && c.sharedContext ? c : null; });
  check('the shared view shows the context, tied to the chosen Thabo',
    r1 && r1.sharedContext.providerId === zanele.providerId && JSON.stringify(r1.sharedContext.context) === JSON.stringify(ctx) && r1.awaitingDecision && r1.awaitingDecision.providerId === zanele.providerId, r1);
  const log = JSON.stringify((await api('GET', `/v1/log/${zanele.tx}`)).body);
  check('the log names the shared fields, not their values', log.includes('elpRegistrationStatus') && !log.includes('whatsapp'));

  const dec = await api('POST', '/v1/provider/decision', { transactionId: zanele.tx, decision: 'decline' });
  check('the Thabo declines', dec.status === 200, dec);
  await until(async () => (await api('GET', `/v1/status/${zanele.tx}`)).body.status === 'rejected');
  const r2 = await row('nutrition');
  check('after a decline the Thabo keeps nothing', r2 && r2.sharedContext === null, r2 && r2.sharedContext);

  section('after a decline she picks another Thabo on the same request');
  const ctx2 = { preferredContact: 'phone' };
  const sel2 = await api('POST', '/v1/select', { transactionId: zanele.tx, practitionerId: P, needType: 'nutrition', providerId: other.providerId, sharedContext: ctx2 });
  check('select another Thabo on the same transaction -> 202', sel2.status === 202, sel2);
  const r3 = await until(async () => { const c = await row('nutrition'); return c && c.sharedContext && c.sharedContext.providerId === other.providerId ? c : null; });
  check('only the new context, for the new Thabo', r3 && JSON.stringify(r3.sharedContext.context) === JSON.stringify(ctx2), r3 && r3.sharedContext);

  section('a Thabo redirects her to another Thabo (referral)');
  const self = await api('POST', '/v1/provider/refer', { transactionId: zanele.tx, referTo: { providerId: other.providerId } });
  check('referring to themselves -> 400', self.status === 400, self);
  const ref = await api('POST', '/v1/provider/refer', { transactionId: zanele.tx, referTo: { providerId: zanele.providerId }, note: 'Zanele covers meal planning' });
  check('the Thabo refers -> 200', ref.status === 200 && ref.body.declined === other.providerId, ref);
  const declined = await until(async () => (await api('GET', `/v1/status/${zanele.tx}`)).body.status === 'rejected');
  check('the referring Thabo\'s request is declined', !!declined);
  const res2 = await until(async () => { const x = (await api('GET', `/v1/results/${zanele.tx}`)).body; return (x.referrals || []).length ? x : null; });
  const referral = res2 && res2.referrals[0];
  check('the referral reaches her request', referral && referral.fromProviderId === other.providerId && referral.referTo.providerId === zanele.providerId && referral.note === 'Zanele covers meal planning', res2 && res2.referrals);
  const inResults = res2 && res2.results.find((r) => r.providerId === zanele.providerId);
  check('the referred Thabo is marked in her results, with their profile', inResults && inResults.referredBy === other.providerId && inResults.thaboRef, inResults);
  const ev = (await api('GET', '/v1/events')).body;
  check('a referral.received event went to the partner', (Array.isArray(ev) ? ev : ev.events || []).some((e) => e.event === 'referral.received' && e.transactionId === zanele.tx && e.providerId === zanele.providerId));
  const sel4 = await api('POST', '/v1/select', { transactionId: zanele.tx, practitionerId: P, needType: 'nutrition', providerId: zanele.providerId, sharedContext: ctx });
  check('she accepts the referral by selecting that Thabo -> 202', sel4.status === 202, sel4);
  await api('POST', '/v1/provider/decision', { transactionId: zanele.tx, decision: 'accept', coachId: zanele.providerId });
  check('the referred Thabo accepts -> reserved', !!(await until(async () => (await api('GET', `/v1/status/${zanele.tx}`)).body.status === 'reserved')));
  section('the Thabo records contributions (UC2 step 9)');
  const contrib = (b) => api('POST', '/v1/provider/contribution', { transactionId: zanele.tx, ...b });
  check('unknown type -> 400', (await contrib({ type: 'gossip', summary: 'x' })).status === 400);
  check('no summary -> 400', (await contrib({ type: 'support_provided' })).status === 400);
  check('follow_up without a date -> 400', (await contrib({ type: 'follow_up', summary: 'check in' })).status === 400);
  check('new_need without a need type -> 400', (await contrib({ type: 'new_need', summary: 'hygiene' })).status === 400);
  check('someone else\'s request -> 409', (await contrib({ type: 'support_provided', summary: 'x', providerId: 'provider-not-me' })).status === 409);
  const day = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
  const c1 = await contrib({ type: 'support_provided', summary: 'Nutrition planning session', details: 'Reviewed the weekly menu' });
  const c2 = await contrib({ type: 'agreed_action', summary: 'Prepare a costed five-day meal plan', dueDate: day(14) });
  const c3 = await contrib({ type: 'follow_up', summary: 'Observation visit', dueDate: day(7) });
  const c4 = await contrib({ type: 'evidence', summary: 'Menu and purchasing list', evidenceRef: 'elevate://evidence/123' });
  const c5 = await contrib({ type: 'new_need', summary: 'Food-preparation area may not meet hygiene requirements', newNeedType: 'health-safety' });
  check('five contributions recorded -> 201', [c1, c2, c3, c4, c5].every((r) => r.status === 201), [c1, c2, c3, c4, c5].map((r) => r.status));
  const r6 = await row('nutrition');
  check('they appear in the shared view, in order', r6 && (r6.contributions || []).map((c) => c.type).join() === 'support_provided,agreed_action,follow_up,evidence,new_need', r6 && r6.contributions);
  check('nextFollowUp is the earliest upcoming date', r6 && r6.nextFollowUp === day(7), r6 && r6.nextFollowUp);
  check('each one names the Thabo who recorded it', r6 && r6.contributions.every((c) => c.providerId === zanele.providerId), r6 && r6.contributions.map((c) => c.providerId));
  check('the new need is named', r6 && r6.contributions[4].newNeedType === 'health-safety', r6 && r6.contributions[4]);

  section('Naledi takes back what she shared (UC2 step 10)');
  const rv = await api('POST', '/v1/consent/revoke', { transactionId: zanele.tx });
  check('revoke -> 200, revoked', rv.status === 200 && rv.body.revoked === true && rv.body.providerId === zanele.providerId, rv);
  const r7 = await row('nutrition');
  check('the Thabo no longer sees the context, and still holds the need', r7 && r7.sharedContext === null && r7.status === 'reserved', r7 && { sharedContext: r7.sharedContext, status: r7.status });
  const rv2 = await api('POST', '/v1/consent/revoke', { transactionId: zanele.tx });
  check('revoking again is harmless -> revoked: false', rv2.status === 200 && rv2.body.revoked === false, rv2);

  const w = await api('POST', '/v1/withdraw', { transactionId: zanele.tx });
  check('Naledi withdraws', [200, 202].includes(w.status), w);
  await until(async () => (await api('GET', `/v1/status/${zanele.tx}`)).body.status === 'withdrawn');
  const r4 = await row('nutrition');
  check('after a withdrawal the Thabo keeps nothing', r4 && r4.sharedContext === null, r4 && r4.sharedContext);

  section('select without context still works as before');
  const plain = await search({ needType: 'nutrition' });
  const sel3 = await api('POST', '/v1/select', { transactionId: plain.tx, practitionerId: P, needType: 'nutrition', providerId: (plain.results[0] || {}).providerId });
  check('select without sharedContext -> 202', sel3.status === 202, sel3);
  const r5 = await until(async () => { const c = await row('nutrition'); return c && c.awaitingDecision ? c : null; });
  check('no context in the shared view', r5 && r5.sharedContext === null, r5 && r5.sharedContext);

  console.log(`\n==== ${passed} passed, ${failures.length} failed ====`);
  if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
