// uc3.js -- checks UC3 progress on a practitioner's capability journey:
// POST /v1/progress (push, e.g. from Elevate's project-service), GET
// /v1/progress (her journey view) and the progress.updated event for
// subscribers.
//
//   API_KEY=<key> node tests/uc3.js
//
// It runs a small webhook receiver (a pretend learning provider) and
// subscribes it to progress.updated. sandbox-bpp must reach that receiver:
//   - stack in Docker on this machine: the default, http://host.docker.internal:<port>
//   - apps running directly on this machine: SUB_HOST=http://127.0.0.1
// Against a live network the receiver is usually not reachable: SKIP_WEBHOOK=1
// checks everything else.

'use strict';

const http = require('http');

const BAP = (process.env.BAP || 'http://localhost:3001').replace(/\/+$/, '');
const KEY = process.env.API_KEY || 'demo-key-change-me';
const PORT = Number(process.env.SUB_PORT || 3078);
const SUB_HOST = process.env.SUB_HOST || 'http://host.docker.internal';
const SKIP_WEBHOOK = process.env.SKIP_WEBHOOK === '1';
const RUN = Date.now().toString(36);
const P = `prac_uc3_${RUN}`;

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

const received = [];
function startReceiver() {
  return new Promise((resolve) => {
    http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try { received.push({ key: req.headers['x-api-key'], ...JSON.parse(body) }); } catch (e) { /* ignore */ }
        res.writeHead(200); res.end('{}');
      });
    }).listen(PORT, resolve);
  });
}

(async () => {
  const push = (b) => api('POST', '/v1/progress', { practitionerId: P, ...b });

  section('push: checks');
  check('no practitionerId -> 400', (await api('POST', '/v1/progress', { event: 'enrolled' })).status === 400);
  check('unknown event -> 400', (await push({ event: 'fell_asleep' })).status === 400);
  check('bad date -> 400', (await push({ event: 'enrolled', at: 'yesterday' })).status === 400);
  check('unknown needType -> 400', (await push({ event: 'enrolled', needType: 'cooking' })).status === 400);
  check('journey view needs practitionerId -> 400', (await api('GET', '/v1/progress')).status === 400);

  let sub = null;
  if (!SKIP_WEBHOOK) {
    section('a learning provider subscribes to progress.updated');
    await startReceiver();
    const s = await api('POST', '/v1/subscriptions', { url: `${SUB_HOST}:${PORT}/hook`, name: `uc3-${RUN}`, events: ['progress.updated'], needTypes: ['nutrition'], secret: `uc3-secret-${RUN}` });
    check('subscribed -> 201', s.status === 201, s);
    sub = s.body;
  }

  section('Elevate pushes her nutrition journey');
  const t = (m) => new Date(Date.now() - m * 60000).toISOString();
  const thabo = { app: 'elevate', userId: `zanele-${RUN}` };
  const steps = [
    { eventId: `ev1-${RUN}`, event: 'enrolled', at: t(50), capability: 'nutrition_planning', needType: 'nutrition', activity: { id: 'course-nf', title: 'Nutrition fundamentals', kind: 'course' } },
    { eventId: `ev2-${RUN}`, event: 'module_completed', at: t(40), capability: 'nutrition_planning', needType: 'nutrition', activity: { id: 'mod-1', title: 'Balanced menus', kind: 'module' } },
    { eventId: `ev3-${RUN}`, event: 'assessment_completed', at: t(30), capability: 'nutrition_planning', needType: 'nutrition', details: 'Knowledge assessment passed' },
    { eventId: `ev4-${RUN}`, event: 'observation_completed', at: t(20), capability: 'nutrition_planning', needType: 'nutrition', thaboRef: thabo, details: 'Meal plan not costed yet' },
    { eventId: `ev5-${RUN}`, event: 'specialist_support_requested', at: t(10), capability: 'health_safety', needType: 'health-safety', thaboRef: thabo, details: 'Food-preparation hygiene' },
    { eventId: `ev6-${RUN}`, event: 'credential_earned', at: t(5), capability: 'nutrition_planning', needType: 'nutrition', evidenceRef: 'elevate://credential/42', source: { app: 'elevate', service: 'project-service' } },
  ];
  const made = [];
  for (const st of steps) made.push(await push(st));
  check('six events stored -> 201', made.every((r) => r.status === 201 && r.body.duplicate === false), made.map((r) => r.status));
  const again = await push(steps[1]);
  check('the same eventId again -> 200 duplicate, not stored twice', again.status === 200 && again.body.duplicate === true && again.body.id === made[1].body.id, again);

  section('her journey view');
  const j = (await api('GET', `/v1/progress?practitionerId=${P}`)).body;
  check('six events, oldest first', j.count === 6 && j.progress.map((e) => e.event).join() === steps.map((s) => s.event).join(), j.progress && j.progress.map((e) => e.event));
  const cred = j.progress && j.progress[5];
  check('details kept (source, activity, evidence)', cred && cred.source.service === 'project-service' && cred.evidenceRef === 'elevate://credential/42', cred);
  const obs = j.progress && j.progress[3];
  check('the Thabo who observed is named', obs && obs.thaboRef && obs.thaboRef.userId === thabo.userId, obs);
  const bycap = (await api('GET', `/v1/progress?practitionerId=${P}&capability=health_safety`)).body;
  check('filter by capability', bycap.count === 1 && bycap.progress[0].event === 'specialist_support_requested', bycap);
  const byev = (await api('GET', `/v1/progress?practitionerId=${P}&event=module_completed`)).body;
  check('filter by event', byev.count === 1, byev);
  const since = (await api('GET', `/v1/progress?practitionerId=${P}&since=${encodeURIComponent(t(25))}`)).body;
  check('filter by since', since.count === 3, since.progress && since.progress.map((e) => e.event));
  const other = (await api('GET', `/v1/progress?practitionerId=prac_nobody_${RUN}`)).body;
  check('another practitioner sees none of it', other.count === 0, other);

  if (!SKIP_WEBHOOK) {
    section('progress.updated reached the subscriber');
    const got = await until(async () => (received.filter((e) => e.practitionerId === P).length >= 5 ? received : null));
    const mine = received.filter((e) => e.practitionerId === P);
    check('five nutrition events delivered (not the health-safety one, not the duplicate)', got && mine.length === 5 && mine.every((e) => e.event === 'progress.updated' && e.payload.needType === 'nutrition'), mine.map((e) => e.payload && e.payload.event));
    check('delivered with the subscription secret', mine.length && mine.every((e) => e.key === `uc3-secret-${RUN}`), mine.map((e) => e.key));
    check('the event carries the progress', mine.some((e) => e.status === 'credential_earned' && e.payload.evidenceRef === 'elevate://credential/42'));
    if (sub && sub.id) await api('DELETE', `/v1/subscriptions/${sub.id}`);
  }

  console.log(`\n==== ${passed} passed, ${failures.length} failed ====`);
  if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
