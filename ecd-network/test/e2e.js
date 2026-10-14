#!/usr/bin/env node
// e2e.js -- the whole ECD network, end to end, against real ONIX adapters.
//
//   Local processes:  ./start-local.sh --fresh --test   then  ONIX_BIN=... ONIX_PLUGINS=... node test/e2e.js
//   Docker:           ./start-docker.sh --fresh --test  then  ECD_MODE=docker ECD_REGISTRY_CACHE_TTL=3s node test/e2e.js
// (test mode: message bodies visible, registry lookups cached 3s instead of 60s)
//
// 1. network core      registry + adapters: signatures, refusals, schema   (network-core.js)
// 2. provider nodes    WeHelp / GROW driven through Journey's adapter       (provider.js)
// 3. UC1 via the Journey node's own API: register, ask, two providers asked,
//    WeHelp answers, consent, booking, accepted with a coach, completed
// 4. consent: only the chosen provider got her details, only the ticked ones
// 5. a replayed message is processed once
// 6. a provider declines: Naledi sees it
// 7. a new node (SmartStart) joins with tools/new-node.js and answers, with no
//    change to any other node; then it is paused and refused
// Exit code 0 only when everything passes. The new node is removed at the end.

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const beckn = require('../lib/beckn');
const { authHeader } = require('./lib/sign');

const ROOT = path.resolve(__dirname, '..');
const DOCKER = process.env.ECD_MODE === 'docker';
const COMPOSE = ['compose', '-f', path.join(ROOT, '.generated/docker-compose.yml')];
// "Has this node been restarted?" -- a pid locally, a container start time in Docker.
const startedAt = (id) => (DOCKER
  ? execFileSync('docker', ['inspect', '-f', '{{.State.StartedAt}}', `ecd-network-${id}-app-1`]).toString().trim()
  : fs.readFileSync(path.join(ROOT, `.run/app-${id}.pid`), 'utf8'));
const readNode = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, `config/nodes/${id}.json`), 'utf8'));
const network = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/network.json'), 'utf8'));
const J = readNode('journey'), W = readNode('wehelp'), G = readNode('grow');
const app = (n) => `http://127.0.0.1:${n.ports.app}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0, passed = 0;
const check = (name, ok, detail) => { if (ok) { passed++; console.log(`  ok    ${name}`); } else { failed++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); } };

// A tiny cookie-keeping client for the Journey node's own API.
function client() {
  let cookie = '';
  const call = async (method, p, body) => {
    const r = await fetch(`${app(J)}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b || {}) };
}
async function until(fn, ms = 10000) { for (let i = 0; i < ms / 200; i++) { const v = await fn(); if (v) return v; await sleep(200); } return null; }
const get = async (u) => (await fetch(u)).json();
const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(async (r) => ({ status: r.status, json: await r.json() }));

function runPart(file) {
  console.log('');
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  check(`${file} passed`, r.status === 0);
}

(async () => {
  runPart('network-core.js');
  runPart('provider.js');

  console.log('\nUC1 through the Journey node');
  const naledi = client();
  const reg = await naledi.post('/api/naledis', { name: 'Naledi M', centre: 'Little Stars ELC', region: 'Alexandra, Gauteng', phone: '+27 821234567' });
  check('register', reg.status === 201 && reg.json.id);
  const asked = await naledi.post('/api/requests', { needType: 'registration' });
  check('ask: request created', asked.status === 202);
  const rid = asked.json.id;
  const mine = async () => (await naledi.get('/api/requests')).json.find((x) => x.id === rid);
  const withAnswer = await until(async () => { const r = await mine(); return r.answers.length && r.asked.length === 2 ? r : null; });
  check('both providers in the registry were asked, both ACKed', withAnswer && withAnswer.asked.every((a) => a.ack === 'ACK'), JSON.stringify(withAnswer && withAnswer.asked));
  await sleep(1000);
  const r1 = await mine();
  check('only WeHelp answered (GROW does not offer registration support)', r1.answers.length === 1 && r1.answers[0].providerId === W.subscriberId, JSON.stringify(r1.answers.map((a) => a.providerName)));
  const tx = r1.transactionId;
  const acc = await naledi.post(`/api/requests/${rid}/accept`, { offerId: r1.answers[0].offerId, share: ['name', 'phone'] });
  check('accept with consent for name and phone', acc.status === 202);
  const pending = await until(async () => { const r = await mine(); return r.status === 'PENDING' ? r : null; });
  check('select, init, confirm done: order PENDING at WeHelp', pending && /^ord-/.test(pending.order.id), pending ? '' : JSON.stringify((await mine()).timeline));

  const order = (await get(`${app(W)}/api/orders`)).find((o) => o.transactionId === tx);
  await post(`${app(W)}/api/orders/${order.id}/accept`, { coach: 'Thabo K' });
  const accepted = await until(async () => { const r = await mine(); return r.status === 'ACCEPTED' ? r : null; });
  check('WeHelp staff accept: Naledi sees ACCEPTED with coach Thabo K', accepted && accepted.order.coach === 'Thabo K');
  const ref = await naledi.post(`/api/requests/${rid}/refresh`);
  check('refresh sends status and is ACKed', ref.status === 202 && ref.json.sent);
  await post(`${app(W)}/api/orders/${order.id}/complete`);
  const done = await until(async () => { const r = await mine(); return r.status === 'COMPLETED' ? r : null; });
  check('WeHelp completes: Naledi sees COMPLETED', !!done);
  const other = client();
  await other.post('/api/naledis', { name: 'Someone else', region: 'Soweto, Gauteng' });
  const peek = await other.get('/api/requests');
  check('another practitioner cannot see her requests', peek.status === 200 && peek.json.length === 0);

  console.log('\nConsent');
  const wMsgs = await get(`${app(W)}/api/messages?transactionId=${tx}`);
  const init = wMsgs.find((m) => m.direction === 'in' && m.action === 'init');
  const shared = init && beckn.readContract(init.body.message).data;
  check('WeHelp\'s init carried name and phone only', shared && shared.name === 'Naledi M' && shared.phone && !('centre' in shared), JSON.stringify(shared));
  const discover = wMsgs.find((m) => m.direction === 'in' && m.action === 'discover');
  check('discover carried no personal details', discover && !JSON.stringify(discover.body).includes('Naledi') && !JSON.stringify(discover.body).includes('821234567'));
  const gMsgs = await get(`${app(G)}/api/messages?transactionId=${tx}`);
  check('GROW received only the discover, never her details', gMsgs.length === 1 && gMsgs[0].action === 'discover' && !JSON.stringify(gMsgs).includes('Naledi'));
  console.log('\nReplay');
  const last = wMsgs.filter((m) => m.direction === 'out' && m.action === 'on_status').pop();
  const again = await fetch(`http://127.0.0.1:${W.ports.onix}/bpp/caller/on_status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(last.body) });
  check('replayed on_status is still ACKed by the adapter', again.ok);
  await sleep(800);
  const jIn = (await get(`${app(J)}/api/messages?transactionId=${tx}`)).filter((m) => m.direction === 'in' && m.messageId === last.messageId);
  check('Journey processed that message once', jIn.length === 1, `${jIn.length} times`);
  const stale = JSON.parse(JSON.stringify(last.body));
  stale.context.messageId = crypto.randomUUID();
  const sd = JSON.parse(stale.message.contract.descriptor.longDesc);
  stale.message.contract.descriptor.longDesc = JSON.stringify({ ...sd, state: 'PENDING', updatedAt: '2000-01-01T00:00:00.000Z' });
  stale.message.contract.status.code = 'ACTIVE';
  await fetch(`http://127.0.0.1:${W.ports.onix}/bpp/caller/on_status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stale) });
  await sleep(800);
  check('an old state arriving late does not undo COMPLETED', (await mine()).status === 'COMPLETED');

  console.log('\nDecline');
  const a2 = await naledi.post('/api/requests', { needType: 'infrastructure' });
  const r2 = await until(async () => { const r = (await naledi.get('/api/requests')).json.find((x) => x.id === a2.json.id); return r.answers.length ? r : null; });
  check('WeHelp answers an infrastructure request', r2 && r2.answers[0].providerId === W.subscriberId);
  await naledi.post(`/api/requests/${r2.id}/accept`, { offerId: r2.answers[0].offerId, share: [] });
  await until(async () => (await naledi.get('/api/requests')).json.find((x) => x.id === r2.id).status === 'PENDING');
  const o2 = (await get(`${app(W)}/api/orders`)).find((o) => o.transactionId === r2.transactionId);
  check('sharing nothing: WeHelp\'s order has no personal details', o2 && o2.customer.sharedFields.length === 0 && !o2.customer.name);
  await post(`${app(W)}/api/orders/${o2.id}/decline`);
  check('WeHelp declines: Naledi sees DECLINED', !!(await until(async () => (await naledi.get('/api/requests')).json.find((x) => x.id === r2.id).status === 'DECLINED')));

  console.log('\nNo provider can help');
  const a9 = await naledi.post('/api/requests', { needType: 'nutrition' });
  const r9 = await until(async () => { const r = (await naledi.get('/api/requests')).json.find((x) => x.id === a9.json.id); return r.status === 'NO_ANSWER' ? r : null; }, 12000);
  check('a request nobody can help with ends as NO_ANSWER (not stuck)', !!r9);

  console.log('\nA new node joins: SmartStart');
  const before = Object.fromEntries(['journey', 'wehelp', 'grow'].map((id) => [id, fs.readFileSync(path.join(ROOT, `config/nodes/${id}.json`), 'utf8')]));
  const pidsBefore = ['journey', 'wehelp', 'grow'].map(startedAt);
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools/new-node.js'), 'smartstart', '--elevate', 'provider-smartstart', '--offer', 'Business support for early learning programmes', '--terms', 'Free'], { stdio: 'ignore', env: process.env });
    if (DOCKER) {
      execFileSync('docker', [...COMPOSE, 'up', '-d', 'smartstart-app'], { stdio: 'ignore', env: process.env });
      // Wait for the app AND its ONIX adapter: the adapter loads the Beckn
      // schema before it listens, so it is often a few seconds behind the app.
      const sn = readNode('smartstart');
      const answers = async (u) => { try { await fetch(u, { signal: AbortSignal.timeout(1000) }); return true; } catch { return false; } };
      const ready = await until(async () => (await answers(`http://127.0.0.1:${sn.ports.app}/health`)) && (await answers(`http://127.0.0.1:${sn.ports.onix}/`)), 90000);
      if (!ready) console.log('        (SmartStart did not come up in 90 s: docker compose -f .generated/docker-compose.yml logs onix-smartstart smartstart-app)');
    } else execFileSync('bash', [path.join(ROOT, 'start-node.sh'), 'smartstart'], { stdio: 'ignore', env: process.env });
    const st = readNode('smartstart');
    check('SmartStart is live in the registry', (await get(`http://127.0.0.1:${network.registryPort}/subscribers`)).subscribers.some((s) => s.subscriber_id === st.subscriberId));
    const third = client();
    await third.post('/api/naledis', { name: 'Lindiwe', region: 'Soweto, Gauteng' });
    const a3 = await third.post('/api/requests', { needType: 'fundraising' });
    const r3 = await until(async () => { const r = (await third.get('/api/requests')).json[0]; return r.answers.length >= 2 ? r : null; });
    const r3seen = r3 || (await third.get('/api/requests')).json[0];
    check('a fundraising request in Gauteng now gets GROW and SmartStart', r3 && r3.answers.map((a) => a.providerName).sort().join() === 'GROW,SmartStart',
      `answers ${JSON.stringify(r3seen && r3seen.answers.map((a) => a.providerName))}, asked ${JSON.stringify(r3seen && r3seen.asked.map((a) => `${a.providerId}:${a.ack}:${a.error || ''}`))}`);
    check('no other node\'s settings changed', ['journey', 'wehelp', 'grow'].every((id) => fs.readFileSync(path.join(ROOT, `config/nodes/${id}.json`), 'utf8') === before[id]));
    check('no other node was restarted', ['journey', 'wehelp', 'grow'].every((id, i) => startedAt(id) === pidsBefore[i]));

    // Pause SmartStart: the registry marks it UNSUBSCRIBED.
    fs.writeFileSync(path.join(ROOT, 'config/nodes/smartstart.json'), JSON.stringify({ ...st, status: 'paused' }, null, 2) + '\n');
    execFileSync(process.execPath, [path.join(ROOT, 'tools/configure.js'), ...(DOCKER ? ['--mode', 'docker'] : [])], { stdio: 'ignore', env: process.env });
    await sleep(4500); // adapters cache registry lookups (3s in test mode)
    const a4 = await third.post('/api/requests', { needType: 'fundraising' });
    const r4 = await until(async () => { const r = (await third.get('/api/requests')).json.find((x) => x.id === a4.json.id); return r.asked.length ? r : null; });
    check('a paused node is not asked', r4 && !r4.asked.some((a) => a.providerId === st.subscriberId), JSON.stringify(r4 && r4.asked.map((a) => a.providerId)));
    const keys = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.keys/smartstart.ecd.bana-pele.env'), 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const members = (await get(`http://127.0.0.1:${network.registryPort}/subscribers?all=1`)).subscribers;
    const ctx = { networkId: network.networkId, action: 'on_status', version: network.version, bapId: J.subscriberId, bapUri: members.find((m) => m.subscriber_id === J.subscriberId).url, bppId: st.subscriberId, bppUri: members.find((m) => m.subscriber_id === st.subscriberId).url, transactionId: crypto.randomUUID(), messageId: crypto.randomUUID(), timestamp: new Date().toISOString() };
    const body = JSON.stringify({ context: ctx, message: beckn.contractMessage({ id: 'ord-x', providerId: st.subscriberId, offerId: 'x', contractStatus: 'ACTIVE' }) });
    const r5 = await fetch(`http://127.0.0.1:${J.ports.onix}/bap/receiver/on_status`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authHeader(body, { subscriberId: st.subscriberId, keyId: keys.KEY_ID, priv: keys.SIGNING_PRIVATE_KEY, pub: keys.SIGNING_PUBLIC_KEY }) }, body });
    const t5 = await r5.text();
    check('a paused node\'s correctly signed message is refused', !t5.includes('"ACK"'), `HTTP ${r5.status} ${t5.slice(0, 160)}`);
  } finally {
    // Leave the repo and the network as they were.
    if (DOCKER) { try { execFileSync('docker', [...COMPOSE, 'rm', '-sf', 'smartstart-app', 'onix-smartstart', 'redis-smartstart'], { stdio: 'ignore' }); } catch { /* not there */ } }
    for (const p of ['app-smartstart', 'onix-smartstart', 'redis-smartstart']) {
      const f = path.join(ROOT, `.run/${p}.pid`);
      if (fs.existsSync(f)) { try { process.kill(Number(fs.readFileSync(f, 'utf8'))); } catch { /* gone */ } fs.unlinkSync(f); }
    }
    for (const f of ['config/nodes/smartstart.json', '.keys/smartstart.ecd.bana-pele.env', '.keys/smartstart.ecd.bana-pele.public.json', 'data/smartstart.json']) fs.rmSync(path.join(ROOT, f), { force: true });
    fs.rmSync(path.join(ROOT, '.generated/onix/smartstart'), { recursive: true, force: true });
    execFileSync(process.execPath, [path.join(ROOT, 'tools/configure.js'), ...(DOCKER ? ['--mode', 'docker'] : [])], { stdio: 'ignore', env: process.env });
  }

  console.log(`\nE2E: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
