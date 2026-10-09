// uc3-learning.js -- checks the rest of UC3 (capability-development journey):
// identity links, learning offerings, learning discovery and enrolment over
// the network, and the capability profile.
//
//   API_KEY=<key> BAP=<network> node tests/uc3-learning.js
//
// Works against the local stack and a live network alike: it registers its
// own learning provider and offerings (in a region of its own), plays both
// the practitioner and the provider, and withdraws/cleans up what it made.

'use strict';

const BAP = (process.env.BAP || 'http://localhost:3001').replace(/\/+$/, '');
const KEY = process.env.API_KEY || 'demo-key-change-me';
const RUN = Date.now().toString(36);
const P = `prac_uc3l_${RUN}`;
const LP = `lp-uc3-${RUN}`; // the learning provider
const REGION = `UC3-Test-${RUN}`;

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
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(300); }
  return null;
}
async function learnSearch(b) {
  const s = await api('POST', '/v1/learning/search', { practitionerId: P, region: REGION, ...b });
  if (s.status !== 202) return { s, results: [] };
  const r = await until(async () => { const x = (await api('GET', `/v1/results/${s.body.transactionId}`)).body; return x.status === 'results_ready' ? x : null; });
  return { s, tx: s.body.transactionId, results: (r && r.results) || [] };
}
const enrolmentOf = async (tx, offeringId) => ((await api('GET', `/v1/status/${tx}`)).body.enrolments || []).find((e) => e.offeringId === offeringId);
const ids = (rs) => rs.map((r) => r.offeringId).sort().join();

(async () => {
  section('1. identity links (Elevate user <-> practitioner)');
  const user = { app: 'elevate', userId: `u-${RUN}` };
  const l1 = await api('POST', '/v1/identity/links', { practitionerId: P, ...user });
  check('link -> 201', l1.status === 201, l1);
  check('same link again -> 200 idempotent', (await api('POST', '/v1/identity/links', { practitionerId: P, ...user })).body.idempotent === true);
  check('same user to another practitioner -> 409', (await api('POST', '/v1/identity/links', { practitionerId: `${P}_other`, ...user })).status === 409);
  check('missing fields -> 400', (await api('POST', '/v1/identity/links', { practitionerId: P })).status === 400);
  const who = await api('GET', `/v1/identity/links?app=elevate&userId=${user.userId}`);
  check('look up the practitioner from the Elevate user', who.status === 200 && who.body.practitionerId === P, who);
  const mine = await api('GET', `/v1/identity/links?practitionerId=${P}`);
  check('her links', mine.body.links && mine.body.links.length === 1, mine.body);
  check('unknown user -> 404', (await api('GET', `/v1/identity/links?app=elevate&userId=nobody-${RUN}`)).status === 404);
  const pu = await api('POST', '/v1/progress', { user, event: 'learning_started', capability: 'classroom_practice', eventId: `lp-${RUN}` });
  check('progress pushed with the Elevate user id lands on her', pu.status === 201 && pu.body.practitionerId === P, pu);
  check('progress for an unlinked user -> 404', (await api('POST', '/v1/progress', { user: { app: 'elevate', userId: `ghost-${RUN}` }, event: 'enrolled' })).status === 404);

  section('2. learning providers publish offerings');
  const add = (b) => api('POST', '/v1/learning/offerings', { providerId: LP, providerName: 'Learning Co', regions: [REGION], ...b });
  check('no capabilities -> 400', (await add({ title: 'x' })).status === 400);
  check('no title -> 400', (await add({ capabilities: ['nutrition_planning'] })).status === 400);
  const A = (await add({ title: 'Nutrition fundamentals (online)', capabilities: ['nutrition_planning'], languages: ['en', 'zu'], deliveryModes: ['remote'], cost: 'free', needsDigitalAccess: true, duration: '4 weeks', entryRequirements: 'None' })).body;
  const B = (await add({ title: 'Menu costing workshop', capabilities: ['nutrition_planning'], languages: ['en'], deliveryModes: ['in_person'], cost: { amount: 500, currency: 'ZAR' }, needsDigitalAccess: false })).body;
  const C = (await add({ title: 'Kitchen hygiene', capabilities: ['health_safety'], languages: ['en', 'zu'], deliveryModes: ['in_person'], cost: 'free' })).body;
  check('three offerings published', !!(A.offeringId && B.offeringId && C.offeringId), [A, B, C]);
  const list = (await api('GET', `/v1/learning/offerings?providerId=${LP}`)).body;
  check('the provider lists its offerings', list.count === 3, list.count);

  section('3. learning discovery over the network');
  check('capability that is not a code -> 400', (await api('POST', '/v1/learning/search', { practitionerId: P, capability: 'Nutrition Planning' })).status === 400);
  check('bad maxCost -> 400', (await api('POST', '/v1/learning/search', { practitionerId: P, capability: 'nutrition_planning', maxCost: -5 })).status === 400);
  const all = await learnSearch({ capability: 'nutrition_planning' });
  check('capability gap -> both nutrition offerings, not hygiene', ids(all.results) === [A.offeringId, B.offeringId].sort().join(), all.results.map((r) => r.title));
  const r0 = all.results.find((r) => r.offeringId === A.offeringId) || {};
  check('offering details come through', r0.providerId === LP && r0.duration === '4 weeks' && r0.cost && r0.cost.amount === 0 && r0.entryRequirements === 'None', r0);
  check('language zu -> online course only', ids((await learnSearch({ capability: 'nutrition_planning', language: 'zu' })).results) === A.offeringId);
  check('maxCost 100 -> free course only', ids((await learnSearch({ capability: 'nutrition_planning', maxCost: 100 })).results) === A.offeringId);
  check('no digital access -> workshop only', ids((await learnSearch({ capability: 'nutrition_planning', digitalAccess: false })).results) === B.offeringId);
  check('in person -> workshop only', ids((await learnSearch({ capability: 'nutrition_planning', deliveryMode: 'in_person' })).results) === B.offeringId);

  section('4. enrolment routed to the learning provider');
  const tx = all.tx;
  check('unknown offering -> 404', (await api('POST', '/v1/learning/enrol', { transactionId: tx, offeringId: 'lo-nope' })).status === 404);
  const plain = await api('POST', '/v1/search', { practitionerId: P, needType: 'nutrition', region: REGION });
  check('enrol on a non-learning request -> 409', (await api('POST', '/v1/learning/enrol', { transactionId: plain.body.transactionId, offeringId: A.offeringId })).status === 409);
  const e1 = await api('POST', '/v1/learning/enrol', { transactionId: tx, offeringId: A.offeringId, sharedContext: { currentLevel: 'beginner' } });
  check('enrol -> 202 requested', e1.status === 202 && e1.body.status === 'requested', e1);
  const atProvider = await until(async () => ((await api('GET', `/v1/learning/enrolments?providerId=${LP}&status=requested`)).body.enrolments || [])[0]);
  check('the provider sees the request, with what she shared', atProvider && atProvider.offeringId === A.offeringId && atProvider.practitionerId === P && atProvider.sharedContext && atProvider.sharedContext.currentLevel === 'beginner', atProvider);
  check('enrol again -> 200 idempotent', (await api('POST', '/v1/learning/enrol', { transactionId: tx, offeringId: A.offeringId })).body.idempotent === true);
  check('decision by another provider -> 409', (await api('POST', '/v1/learning/enrolment-decision', { enrolmentId: atProvider.enrolmentId || atProvider.id, providerId: 'lp-other', decision: 'accept' })).status === 409);
  const acc = await api('POST', '/v1/learning/enrolment-decision', { enrolmentId: atProvider.id, decision: 'accept' });
  check('provider accepts -> 200 enrolled', acc.status === 200 && acc.body.status === 'enrolled', acc);
  check('Naledi\'s side hears it over the network -> enrolled', !!(await until(async () => ((await enrolmentOf(tx, A.offeringId)) || {}).status === 'enrolled')));
  const prog = (await api('GET', `/v1/progress?practitionerId=${P}&event=enrolled`)).body;
  check('"enrolled" joins her journey automatically', prog.count === 1 && prog.progress[0].capability === 'nutrition_planning' && prog.progress[0].activity.id === A.offeringId, prog);

  const e2 = await api('POST', '/v1/learning/enrol', { transactionId: tx, offeringId: B.offeringId });
  check('enrol in the workshop -> 202', e2.status === 202, e2);
  const atP2 = await until(async () => ((await api('GET', `/v1/learning/enrolments?providerId=${LP}&status=requested`)).body.enrolments || [])[0]);
  await api('POST', '/v1/learning/enrolment-decision', { enrolmentId: atP2.id, decision: 'decline', note: 'Full this month' });
  check('provider declines -> declined on her side', !!(await until(async () => ((await enrolmentOf(tx, B.offeringId)) || {}).status === 'declined')));

  const rf = await api('POST', `/v1/status/${tx}/refresh`);
  check('status check on the enrolments -> 202', rf.status === 202, rf);
  await sleep(1500);
  check('still enrolled after the check', ((await enrolmentOf(tx, A.offeringId)) || {}).status === 'enrolled');

  section('5. capability profile');
  const push = (b) => api('POST', '/v1/progress', { practitionerId: P, ...b });
  const thabo = { app: 'elevate', userId: `zanele-${RUN}` };
  await push({ event: 'module_completed', capability: 'nutrition_planning', thaboRef: thabo });
  await push({ event: 'observation_completed', capability: 'nutrition_planning', thaboRef: thabo, evidenceRef: 'elevate://obs/1' });
  await push({ event: 'credential_earned', capability: 'nutrition_planning', evidenceRef: 'elevate://credential/42' });
  await push({ event: 'support_requested', capability: 'health_safety' });
  await push({ event: 'assessment_completed', capability: 'business_sustainability' });
  const prof = (await api('GET', `/v1/capabilities?practitionerId=${P}`)).body;
  const cap = (c) => (prof.capabilities || []).find((x) => x.capability === c) || {};
  check('needs practitionerId -> 400', (await api('GET', '/v1/capabilities')).status === 400);
  check('nutrition planning: demonstrated', cap('nutrition_planning').status === 'demonstrated', cap('nutrition_planning').status);
  check('health & safety: needs support', cap('health_safety').status === 'needs_support', cap('health_safety').status);
  check('business sustainability: developing', cap('business_sustainability').status === 'developing', cap('business_sustainability').status);
  check('classroom practice: in progress', cap('classroom_practice').status === 'in_progress', cap('classroom_practice').status);
  check('supporting Thabo named', (cap('nutrition_planning').supportingThabos || []).some((t) => t.userId === thabo.userId), cap('nutrition_planning').supportingThabos);
  check('credential other providers can reference', (cap('nutrition_planning').credentials || []).some((c) => c.evidenceRef === 'elevate://credential/42'), cap('nutrition_planning').credentials);
  check('evidence listed', (cap('nutrition_planning').evidence || []).some((c) => c.evidenceRef === 'elevate://obs/1'));
  check('enrolments shown with the capability', (cap('nutrition_planning').enrolments || []).map((e) => e.status).sort().join() === 'declined,enrolled', cap('nutrition_planning').enrolments);

  section('6. withdraw and clean up');
  const w = await api('POST', '/v1/learning/withdraw', { transactionId: tx, offeringId: A.offeringId });
  check('withdraw -> 202', w.status === 202, w);
  check('withdrawn on her side', !!(await until(async () => ((await enrolmentOf(tx, A.offeringId)) || {}).status === 'withdrawn')));
  const atP3 = ((await api('GET', `/v1/learning/enrolments?providerId=${LP}&status=withdrawn`)).body.enrolments || [])[0];
  check('withdrawn at the provider, without her shared context', atP3 && !atP3.sharedContext, atP3);
  for (const o of [A, B, C]) await api('DELETE', `/v1/learning/offerings/${o.offeringId}`);
  check('offerings removed', (await api('GET', `/v1/learning/offerings?providerId=${LP}`)).body.count === 0);
  await api('POST', '/v1/withdraw', { transactionId: plain.body.transactionId });

  console.log(`\n==== ${passed} passed, ${failures.length} failed ====`);
  if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
