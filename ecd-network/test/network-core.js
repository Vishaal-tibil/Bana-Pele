#!/usr/bin/env node
// network-core.js -- checks the network layer itself: our registry and the
// real ONIX adapters. Run against a running network (start-local.sh or
// docker compose). Exit code 0 only when every check passes.
//
//   node test/network-core.js
//
// It talks to the adapters on 127.0.0.1 using the ports in config/nodes/*.json
// (docker-compose.yml publishes the same ports).

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { authHeader, newKeyPair } = require('./lib/sign');

const ROOT = path.resolve(__dirname, '..');
const nodes = Object.fromEntries(fs.readdirSync(path.join(ROOT, 'config/nodes')).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'config/nodes', f), 'utf8'))).map((n) => [n.id, n]));
const network = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/network.json'), 'utf8'));
const keyOf = (n) => Object.fromEntries(fs.readFileSync(path.join(ROOT, '.keys', `${n.subscriberId}.env`), 'utf8')
  .split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

const J = nodes.journey, W = nodes.wehelp;
const local = (n) => `http://127.0.0.1:${n.ports.onix}`;
let failed = 0, passed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: text });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { status: r.status, ack: j && j.message && j.message.ack && j.message.ack.status, text: t };
}

async function received(n, messageId) {
  for (let i = 0; i < 20; i++) {
    const list = await (await fetch(`http://127.0.0.1:${n.ports.app}/api/messages`)).json();
    if (list.some((m) => m.messageId === messageId)) return true;
    await sleep(100);
  }
  return false;
}

function discover(members, overrides = {}) {
  const m = Object.fromEntries(members.map((s) => [s.subscriber_id, s]));
  return {
    context: {
      networkId: network.networkId, action: 'discover', version: network.version,
      bapId: J.subscriberId, bapUri: m[J.subscriberId].url,
      bppId: W.subscriberId, bppUri: m[W.subscriberId].url,
      transactionId: crypto.randomUUID(), messageId: crypto.randomUUID(),
      timestamp: new Date().toISOString(), ttl: 'PT30S', ...overrides,
    },
    message: { intent: { textSearch: JSON.stringify({ needType: 'registration', region: 'Alexandra' }) } },
  };
}

(async () => {
  console.log('Network core: registry + ONIX adapters');
  const reg = `http://127.0.0.1:${network.registryPort}`;
  const members = (await (await fetch(`${reg}/subscribers?all=1`)).json()).subscribers;
  check('registry lists every node', Object.values(nodes).every((n) => members.some((s) => s.subscriber_id === n.subscriberId)));

  const jk = keyOf(J);
  const look = await (await fetch(`${reg}/lookup`, { method: 'POST', body: JSON.stringify({ subscriber_id: J.subscriberId, key_id: jk.KEY_ID }) })).json();
  check('registry answers ONIX\'s lookup with the right public key', Array.isArray(look) && look.length === 1 && look[0].signing_public_key === jk.SIGNING_PUBLIC_KEY);

  // 1. The real path: Journey's app -> Journey's adapter -> WeHelp's adapter -> WeHelp's app.
  const d1 = discover(members);
  const r1 = await post(`${local(J)}/bap/caller/discover`, d1);
  check('discover through Journey\'s adapter gets WeHelp\'s signed ACK', r1.status === 200 && r1.ack === 'ACK', r1.text.slice(0, 200));
  check('WeHelp\'s app received that discover', await received(W, d1.context.messageId));

  // 2. Straight to WeHelp's receiver, signed with Journey's real key: proves our test signer matches ONIX.
  const wehelpReceiver = `${local(W)}/bpp/receiver/discover`;
  const d2 = discover(members); const t2 = JSON.stringify(d2);
  const r2 = await post(wehelpReceiver, t2, { Authorization: authHeader(t2, { subscriberId: J.subscriberId, keyId: jk.KEY_ID, priv: jk.SIGNING_PRIVATE_KEY, pub: jk.SIGNING_PUBLIC_KEY }) });
  check('hand-signed with Journey\'s real key: ACK', r2.status === 200 && r2.ack === 'ACK', r2.text.slice(0, 200));

  // 3. Forged: right subscriber and key id, wrong private key.
  const fake = newKeyPair();
  const d3 = discover(members); const t3 = JSON.stringify(d3);
  const r3 = await post(wehelpReceiver, t3, { Authorization: authHeader(t3, { subscriberId: J.subscriberId, keyId: jk.KEY_ID, ...fake }) });
  check('forged signature: NACK and not delivered', r3.ack !== 'ACK' && !(await received(W, d3.context.messageId)), `HTTP ${r3.status} ${r3.text.slice(0, 160)}`);

  // 4. A sender that is not in our registry.
  const d4 = discover(members, { bapId: 'intruder.example.org' }); const t4 = JSON.stringify(d4);
  const r4 = await post(wehelpReceiver, t4, { Authorization: authHeader(t4, { subscriberId: 'intruder.example.org', keyId: 'k1', ...fake }) });
  check('sender not in the registry: NACK', r4.ack !== 'ACK' && !(await received(W, d4.context.messageId)), `HTTP ${r4.status} ${r4.text.slice(0, 160)}`);

  // 5. No signature at all.
  const d5 = discover(members);
  const r5 = await post(wehelpReceiver, d5);
  check('unsigned message: NACK', r5.ack !== 'ACK' && !(await received(W, d5.context.messageId)), `HTTP ${r5.status} ${r5.text.slice(0, 160)}`);

  // 6. Body changed after signing.
  const d6 = discover(members); const t6 = JSON.stringify(d6);
  const h6 = authHeader(t6, { subscriberId: J.subscriberId, keyId: jk.KEY_ID, priv: jk.SIGNING_PRIVATE_KEY, pub: jk.SIGNING_PUBLIC_KEY });
  const r6 = await post(wehelpReceiver, t6.replace('Alexandra', 'Soweto'), { Authorization: h6 });
  check('body altered after signing: NACK', r6.ack !== 'ACK' && !(await received(W, d6.context.messageId)), `HTTP ${r6.status} ${r6.text.slice(0, 160)}`);

  // 7. Expired signature.
  const d7 = discover(members); const t7 = JSON.stringify(d7); const past = Math.floor(Date.now() / 1000) - 3600;
  const r7 = await post(wehelpReceiver, t7, { Authorization: authHeader(t7, { subscriberId: J.subscriberId, keyId: jk.KEY_ID, priv: jk.SIGNING_PRIVATE_KEY, pub: jk.SIGNING_PUBLIC_KEY, created: past - 60, expires: past }) });
  check('expired signature: NACK', r7.ack !== 'ACK' && !(await received(W, d7.context.messageId)), `HTTP ${r7.status} ${r7.text.slice(0, 160)}`);

  // 8. Signed by a real member (WeHelp) but claiming to come from Journey.
  const wk = keyOf(W);
  const dI = discover(members); const tI = JSON.stringify(dI);
  const rI = await post(`${local(nodes.grow)}/bpp/receiver/discover`, tI, { Authorization: authHeader(tI, { subscriberId: W.subscriberId, keyId: wk.KEY_ID, priv: wk.SIGNING_PRIVATE_KEY, pub: wk.SIGNING_PUBLIC_KEY }) });
  check('a member signing as another member: NACK', rI.ack !== 'ACK' && /UNAUTHORIZED|mismatch/i.test(rI.text), `HTTP ${rI.status} ${rI.text.slice(0, 160)}`);

  // 9. Nothing but the node's own adapter can post into an app.
  const wApp = `http://127.0.0.1:${W.ports.app}`;
  const guess = await fetch(`${wApp}/beckn/webhook/discover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(discover(members)) });
  check('the app\'s webhook is not at a guessable path', guess.status === 404);
  const rebinding = await new Promise((resolve) => {
    require('http').get({ host: '127.0.0.1', port: W.ports.app, path: '/api/orders', headers: { Host: 'evil.example:80' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', () => resolve(0));
  });
  check('an app refuses requests for a host name it does not serve', rebinding === 421, `HTTP ${rebinding}`);

  // 10. A body that breaks the Beckn v2 schema never leaves Journey's adapter.
  const d8 = discover(members); d8.message = { intent: { notAField: true } };
  const r8 = await post(`${local(J)}/bap/caller/discover`, d8);
  check('body that breaks the Beckn v2 schema: refused by the sending adapter', r8.ack !== 'ACK' && !(await received(W, d8.context.messageId)), `HTTP ${r8.status} ${r8.text.slice(0, 160)}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
