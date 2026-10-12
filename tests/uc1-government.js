// uc1-government.js -- checks GET /v1/government-status: Government as a network node
// (UC1, "A Coordinated Support Network Around Every Naledi"). The backbone proxies this
// live to bana-pele-gov-service; we hold no copy of the record.
//
//   API_KEY=<key> node tests/uc1-government.js
//
// Runs its own tiny stand-in for bana-pele-gov-service. sandbox-bpp must be able to reach
// it the same way tests/uc1.js's webhook receiver needs to be reachable:
//   - stack in Docker on this machine: the default, http://host.docker.internal:<port>
//   - apps running directly on this machine: GOV_HOST=http://127.0.0.1
// Needs the stack running (bash start.sh), and GOV_MOCK_BASE_URL/GOV_MOCK_API_KEY pointed
// at the address this test's stub listens on before the stack starts.

'use strict';

const http = require('http');

const BAP = process.env.BAP || 'http://localhost:3001';
const KEY = process.env.API_KEY || 'demo-key-change-me';
const GOV_PORT = Number(process.env.GOV_PORT || 3079);
const GOV_KEY = process.env.GOV_MOCK_API_KEY || 'demo-key-change-me';
const P = `prac_uc1_gov_${Date.now().toString(36)}`;

let passed = 0;
const failures = [];
function section(t) { console.log(`\n== ${t}`); }
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail).slice(0, 300) : ''}`); }
}
async function api(method, path, key = KEY) {
  const res = await fetch(BAP + path, { method, headers: key ? { 'X-Api-Key': key } : {} });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch (e) { body = text; }
  return { status: res.status, body };
}

const record = {
  practitionerId: '77', registrationStatus: 'in_progress', applicationStage: 'DSD review',
  actionRequired: false, actionNote: 'Registration is already with DSD.', updatedAt: '2026-10-09T10:06:40Z',
};

// Stand-in for bana-pele-gov-service: one known practitioner, a wrong key, and a crash.
const gov = http.createServer((req, res) => {
  if (req.headers['x-api-key'] !== GOV_KEY) return res.writeHead(401).end();
  const id = decodeURIComponent(req.url.split('/').pop());
  if (id === 'crash') return req.socket.destroy();
  const body = id === '77' ? record : { practitionerId: id, registrationStatus: 'not_started', actionRequired: false };
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
});

(async () => {
  await new Promise((r) => gov.listen(GOV_PORT, r));
  console.log(`gov-mock stand-in listening on ${GOV_PORT} (point GOV_MOCK_BASE_URL/GOV_MOCK_API_KEY=${GOV_KEY} at it before starting the stack)`);

  section('1. No practitionerId -> 400');
  let r = await api('GET', '/v1/government-status');
  check('missing practitionerId is rejected', r.status === 400, r);

  section('2. A known practitioner\'s status comes back as-is, unmodified');
  r = await api('GET', '/v1/government-status?practitionerId=77');
  check('200', r.status === 200, r);
  check('record matches gov-mock exactly, not reshaped', JSON.stringify(r.body) === JSON.stringify(record), r.body);

  section('3. An unknown practitioner still gets 200 with a default shape, not 404');
  r = await api(`GET`, `/v1/government-status?practitionerId=${P}`);
  check('200, not an error', r.status === 200, r);
  check('default registrationStatus', r.body.registrationStatus === 'not_started', r.body);

  section('4. Wrong network key is refused before gov-mock is even asked');
  r = await api('GET', '/v1/government-status?practitionerId=77', 'wrong-key');
  check('401', r.status === 401, r);

  section('5. gov-mock unreachable -> 502, not a crash or a hang');
  r = await api('GET', '/v1/government-status?practitionerId=crash');
  check('502 government_unavailable', r.status === 502 && r.body.error === 'government_unavailable', r);

  gov.close();
  console.log(`\n==== ${passed} passed, ${failures.length} failed ====`);
  if (failures.length) { console.log('Failed checks:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error('\nTEST RUN CRASHED:', e); gov.close(); process.exit(2); });
