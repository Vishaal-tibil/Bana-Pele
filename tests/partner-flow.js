// partner-flow.js -- the whole "script 1" story, driven through a partner app
// built with the kit (the reference app) and the real network underneath.
//
//   API_KEY=<key> node tests/partner-flow.js
//
// Needs the stack started with `bash start.sh --reference` (the reference app on
// :3004 connected to our network). It also stops and starts the edge to prove
// the partner app keeps working when the network is unreachable.
//
// Environment (all optional except API_KEY):
//   REF         the partner app's API address   (default http://localhost:3004/api/v1)
//   EDGE        the network's /v1 address       (default http://localhost:3010)
//   PUBLIC_URL  also check this public address  (for example the tunnel URL)
//
// To run the whole story over the public internet, put the reference app behind
// its own tunnel, set REF to that address, and EDGE and PUBLIC_URL to our tunnel URL.

'use strict';

const { spawnSync } = require('child_process');

const REF = process.env.REF || 'http://localhost:3004/api/v1';
const EDGE = process.env.EDGE || 'http://localhost:3010';
const KEY = process.env.API_KEY;
if (!KEY) { console.error('Set API_KEY (the key in install/.env)'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
const section = (t) => console.log(`\n== ${t}`);
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
  return !!cond;
}
async function http(base, method, path, body, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
  return { status: res.status, body: json };
}
const ref = (m, p, b) => http(REF, m, p, b);
const net = (m, p, b) => http(EDGE, m, p, b, { 'X-Api-Key': KEY });
async function waitFor(fn, timeout = 10000, every = 250) {
  const end = Date.now() + timeout;
  for (;;) {
    let v; try { v = await fn(); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}
const debug = async () => (await ref('GET', '/debug/state')).body;
const docker = (args) => { const r = spawnSync('docker', args, { encoding: 'utf8' }); return `${r.stdout || ''}${r.stderr || ''}`; };

const NALEDI = { name: 'Naledi Mahlangu', phone: '+27 81 234 5678', language: 'Zulu', area: 'Alexandra, Johannesburg', ecdName: 'Sunshine ECD', tier: 'Pre-Bronze', children: 28 };
const ID = 'prac_naledi_mahlangu';

(async () => {
  console.log('Partner flow: reference partner app + real network');
  const T0 = new Date(Date.now() - 2000).toISOString();

  section('1. Start clean');
  let r = await ref('POST', '/admin/reset');
  check('partner app reset (and the network with it)', r.status === 200, r);
  let d = await debug();
  check('partner app has the network switched on', d.networkEnabled === true, d.networkEnabled);
  r = await http(REF, 'GET', '/network/health');
  check('partner /network/health is public and answers', r.status === 200 && r.body.ok === true, r);
  r = await http(REF, 'GET', '/network/match?needType=registration&region=Alexandra&tier=Pre-Bronze&children=28');
  check('partner /network/match refuses a call without the key', r.status === 401, r.status);
  r = await http(REF, 'GET', '/network/match?needType=registration&region=Alexandra&tier=Pre-Bronze&children=28', null, { 'X-Api-Key': KEY });
  check('partner /network/match answers WeHelp for the sample practitioner', r.status === 200 && r.body.matches.length === 1 && r.body.matches[0].providerId === 'provider-wehelp', r.body);
  r = await http(REF, 'GET', '/network/match?needType=registration&region=Soweto', null, { 'X-Api-Key': KEY });
  check('partner /network/match answers "no match" outside Alexandra', r.status === 200 && r.body.matches.length === 0, r.body);

  section('2. Naledi signs up  (script steps 3-4)');
  r = await ref('POST', '/practitioners/signup', NALEDI);
  check('signup succeeds and goes out over the network', r.status === 200 && r.body.path === 'network', r.body);
  const note = await waitFor(async () => ((await ref('GET', '/views/ngo/work-items')).body.data || []).find((i) => i.practitionerId === ID && i.category === 'New Practitioner Onboarded'));
  check('WeHelp gets "New Practitioner Onboarded" -- delivered by the network', !!note && note.via === 'network', note);
  d = await debug();
  const tx = d.practitioners[ID].tx;
  check('Naledi\'s record holds the network transaction id', !!tx, tx);
  r = await ref('POST', '/practitioners/signup', { name: 'Sipho Dlamini', phone: '+27 82 000 0000', language: 'Zulu', area: 'Soweto', tier: 'Pre-Bronze', children: 20 });
  await sleep(2500);
  check('a practitioner outside WeHelp\'s area does NOT reach WeHelp', !((await ref('GET', '/views/ngo/work-items')).body.data || []).some((i) => i.practitionerId === 'prac_sipho_dlamini'));

  section('3. WeHelp sends an offer  (steps 8-10)');
  r = await ref('POST', '/offers', { practitionerId: ID, title: 'Registration guidance and DSD submission support', area: 'Registration', note: 'Three sessions' });
  const offer = r.body;
  check('offer created', r.status === 200 && !!offer.id, r);
  const seen = await waitFor(async () => ((await ref('GET', `/views/naledi/support-offers?practitionerId=${ID}`)).body.data || []).find((o) => o.id === offer.id));
  check('the offer appears in Naledi\'s Support Offers -- delivered by the network', !!seen && seen.deliveredVia === 'network', seen);
  check('WeHelp\'s queue shows the offer', ((await ref('GET', '/views/ngo/work-items')).body.data || []).some((i) => i.id === offer.id));

  section('4. Naledi accepts, WeHelp assigns  (step 11)');
  r = await ref('POST', `/offers/${offer.id}/accept`);
  check('accept works', r.status === 200);
  r = await ref('POST', `/offers/${offer.id}/accept`);
  check('accepting again is safe', r.status === 200);
  r = await ref('POST', '/offers/off_nope/accept');
  check('accepting an unknown offer -> 404', r.status === 404, r.status);
  let st = await waitFor(async () => { const s = (await net('GET', `/v1/status/${tx}`)).body; return s.status === 'pending' ? s : null; });
  check('the network shows the request waiting for WeHelp (pending)', !!st, st);
  r = await ref('POST', `/offers/${offer.id}/assign`, { coachId: 'coach_thabo_nkosi' });
  check('assign works', r.status === 200 && r.body.coachId === 'coach_thabo_nkosi', r.body);
  st = await waitFor(async () => { const s = (await net('GET', `/v1/status/${tx}`)).body; return s.status === 'reserved' ? s : null; });
  check('the network shows the need reserved', !!st, st);
  const inProg = await waitFor(async () => Object.values((await debug()).cases).find((c) => c.stage === 'In progress' && c.reservedByNetwork));
  check('the partner app moved the case to "In progress" on the network\'s event', !!inProg, inProg);

  section('5. Fulfilment  (step 12)');
  r = await ref('POST', `/offers/${offer.id}/complete`);
  check('complete works', r.status === 200 && r.body.stage === 'Completed', r.body);
  st = await waitFor(async () => { const s = (await net('GET', `/v1/status/${tx}`)).body; return s.status === 'fulfilled' ? s : null; });
  check('the network shows fulfilled', !!st, st);
  const ful = await waitFor(async () => Object.values((await debug()).cases).find((c) => c.fulfilledByNetwork));
  check('the partner app received the network\'s "fulfilled" event', !!ful);
  d = await debug();
  const ev = d.log.filter((l) => / event /.test(l)).map((l) => l.replace(/^\S+ event /, '').trim());
  const want = ['practitioner.matched matched', 'offer.received offered', 'request.received awaiting_decision', 'status.changed reserved', 'request.received awaiting_decision', 'status.changed fulfilled'];
  check('the six events arrived exactly once each, in the right order', JSON.stringify(ev) === JSON.stringify(want), ev);

  section('6. The network disappears: the partner app must keep working');
  docker(['stop', 'naledi-edge']);
  await sleep(1500);
  r = await ref('POST', '/practitioners/signup', { ...NALEDI, name: 'Thandi Local', phone: '+27 83 000 0000' });
  check('signup still works, on local logic', r.status === 200 && r.body.path === 'local', r.body);
  const localNote = ((await ref('GET', '/views/ngo/work-items')).body.data || []).find((i) => i.practitionerId === 'prac_thandi_local');
  check('WeHelp still gets the notification (local matching)', !!localNote && localNote.via === 'local', localNote);
  r = await ref('POST', '/offers', { practitionerId: 'prac_thandi_local', title: 'Local offer', area: 'Registration' });
  const lo = r.body;
  const lseen = ((await ref('GET', '/views/naledi/support-offers?practitionerId=prac_thandi_local')).body.data || []).find((o) => o.id === lo.id);
  check('the offer is visible to Naledi immediately (local)', !!lseen && lseen.deliveredVia === 'local', lseen);
  await ref('POST', `/offers/${lo.id}/accept`);
  r = await ref('POST', `/offers/${lo.id}/assign`, { coachId: 'coach_thabo_nkosi' });
  check('assign works locally', r.status === 200 && r.body.coachId === 'coach_thabo_nkosi' && r.body.stage === 'In progress', r.body);
  r = await ref('POST', `/offers/${lo.id}/complete`);
  check('complete works locally', r.status === 200 && r.body.stage === 'Completed', r.body);
  docker(['start', 'naledi-edge']);
  const back = await waitFor(async () => (await net('GET', '/v1/health')).status === 200, 30000, 500);
  check('the network comes back', !!back);

  if (process.env.PUBLIC_URL) {
    section('7. The public address');
    r = await http(process.env.PUBLIC_URL, 'GET', '/v1/health');
    check('public /v1/health answers', r.status === 200 && r.body.ok === true, r);
    r = await http(process.env.PUBLIC_URL, 'POST', '/v1/search', { practitionerId: 'x', needType: 'registration' });
    check('public /v1/search without the key -> 401', r.status === 401, r.status);
    r = await http(process.env.PUBLIC_URL, 'GET', '/api/state');
    check('the public address does not expose the internal routes', r.status === 404, r.status);
  }

  section('8. Adapter logs');
  const both = docker(['logs', 'onix-bap', '--since', T0]) + docker(['logs', 'onix-bpp', '--since', T0]);
  check('no error-level lines in either adapter', !both.split('\n').some((l) => l.includes('"level":"error"')));
  check('no schema rejections or NACKs', !both.split('\n').some((l) => !/passed/i.test(l) && /is unsupported|validation (failed|error)|"NACK"/i.test(l)));

  await ref('POST', '/admin/reset');
  console.log(`\n==== ${passed} passed, ${failures.length} failed ====`);
  if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error('\nTEST RUN CRASHED:', e); process.exit(2); });
