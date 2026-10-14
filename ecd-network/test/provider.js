#!/usr/bin/env node
// provider.js -- phase 2 check: drives the provider nodes the way a BAP would,
// through Journey's real ONIX adapter, and reads what comes back at Journey's
// webhook. Needs a running network. Exit 0 only when every check passes.

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const beckn = require('../lib/beckn');

const ROOT = path.resolve(__dirname, '..');
const nodes = Object.fromEntries(fs.readdirSync(path.join(ROOT, 'config/nodes')).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'config/nodes', f), 'utf8'))).map((n) => [n.id, n]));
const network = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/network.json'), 'utf8'));
const J = nodes.journey, W = nodes.wehelp, G = nodes.grow;
const app = (n) => `http://127.0.0.1:${n.ports.app}`;
let failed = 0, passed = 0;
const check = (name, ok, detail) => { if (ok) { passed++; console.log(`  ok    ${name}`); } else { failed++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (u) => (await fetch(u)).json();

let members;
async function send(action, provider, transactionId, message) {
  const m = Object.fromEntries(members.map((s) => [s.subscriber_id, s]));
  const body = {
    context: {
      networkId: network.networkId, action, version: network.version,
      bapId: J.subscriberId, bapUri: m[J.subscriberId].url,
      bppId: provider.subscriberId, bppUri: m[provider.subscriberId].url,
      transactionId, messageId: crypto.randomUUID(), timestamp: new Date().toISOString(), ttl: 'PT30S',
    },
    message,
  };
  const r = await fetch(`http://127.0.0.1:${J.ports.onix}/bap/caller/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  return { ok: r.ok && t.includes('"ACK"'), text: t, messageId: body.context.messageId };
}
async function answerAtJourney(transactionId, action, from, ms = 4000) {
  for (let i = 0; i < ms / 100; i++) {
    const list = await get(`${app(J)}/api/messages`);
    const hit = list.find((x) => x.direction === 'in' && x.transactionId === transactionId && x.action === action && (!from || x.from === from));
    if (hit) return hit;
    await sleep(100);
  }
  return null;
}
const contract = (id, provider, offer, status, kind, data) => beckn.contractMessage({ id, providerId: provider.subscriberId, providerName: provider.name, needType: 'registration', offerId: offer.offerId, offerTitle: offer.title, contractStatus: status, kind, data });

(async () => {
  console.log('Provider nodes (WeHelp, GROW) driven through Journey\'s adapter');
  members = (await get(`http://127.0.0.1:${network.registryPort}/subscribers`)).subscribers;

  // Registration help in Alexandra: WeHelp covers it, GROW does not.
  const tx = crypto.randomUUID();
  const dW = await send('discover', W, tx, beckn.discoverMessage({ needType: 'registration', region: 'Alexandra, Gauteng' }));
  const dG = await send('discover', G, tx, beckn.discoverMessage({ needType: 'registration', region: 'Alexandra, Gauteng' }));
  check('both providers ACK the discover', dW.ok && dG.ok, `${dW.text} | ${dG.text}`);
  const onW = await answerAtJourney(tx, 'on_discover', W.subscriberId);
  check('WeHelp answers on_discover (registration, Alexandra)', !!onW);
  const offer = onW && beckn.readCatalogs(onW.body.message)[0];
  check('WeHelp\'s offer and reasons come through', offer && offer.offerId && offer.why.length >= 2, JSON.stringify(offer));
  await sleep(500);
  check('GROW stays silent: it does not offer registration support', !(await answerAtJourney(tx, 'on_discover', G.subscriberId, 300)));
  const askedG = await get(`${app(G)}/api/asked`);
  check('GROW recorded why it did not answer', askedG[0] && askedG[0].answered === false && /does not cover/.test(askedG[0].reasons[0]));

  // Business and financial support in Gauteng: GROW answers.
  const tx2 = crypto.randomUUID();
  await send('discover', G, tx2, beckn.discoverMessage({ needType: 'fundraising', region: 'Soweto, Gauteng' }));
  check('GROW answers on_discover for fundraising in Gauteng', !!(await answerAtJourney(tx2, 'on_discover', G.subscriberId)));

  // Book WeHelp: select, init with only name and phone, confirm.
  const cid = `contract-${tx.slice(0, 8)}`;
  await send('select', W, tx, contract(cid, W, offer, 'DRAFT'));
  check('on_select comes back', !!(await answerAtJourney(tx, 'on_select', W.subscriberId)));
  await send('init', W, tx, contract(cid, W, offer, 'DRAFT', 'shared-details', { sharedFields: ['name', 'phone'], name: 'Naledi M', phone: '+27 821234567', centre: 'MUST NOT ARRIVE', region: 'Alexandra, Gauteng' }));
  check('on_init comes back', !!(await answerAtJourney(tx, 'on_init', W.subscriberId)));
  await send('confirm', W, tx, contract(cid, W, offer, 'ACTIVE'));
  const onC = await answerAtJourney(tx, 'on_confirm', W.subscriberId);
  const oc = onC && beckn.readContract(onC.body.message);
  check('on_confirm carries the order id, ACTIVE, state PENDING', oc && /^ord-/.test(oc.id) && oc.status === 'ACTIVE' && oc.data.state === 'PENDING', JSON.stringify(oc));

  const orders = await get(`${app(W)}/api/orders`);
  const order = orders.find((o) => o.transactionId === tx);
  check('WeHelp has the order with only the ticked fields', order && order.customer.name === 'Naledi M' && order.customer.phone && !('centre' in order.customer), JSON.stringify(order && order.customer));

  // Staff accept with a coach, then complete.
  const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const acc = await post(`${app(W)}/api/orders/${order.id}/accept`, { coach: 'Thabo Nkosi' });
  check('staff accept is delivered to Journey (signed ACK)', acc.status === 200 && acc.json.delivered, JSON.stringify(acc.json).slice(0, 200));
  const st1 = await answerAtJourney(tx, 'on_status', W.subscriberId);
  const s1 = st1 && beckn.readContract(st1.body.message);
  check('Journey gets on_status ACCEPTED with the coach', s1 && s1.data.state === 'ACCEPTED' && s1.coach === 'Thabo Nkosi', JSON.stringify(s1));
  const twice = await post(`${app(W)}/api/orders/${order.id}/accept`, { coach: 'X' });
  check('accepting twice is refused', twice.status === 409);
  await post(`${app(W)}/api/orders/${order.id}/complete`);
  await sleep(300);
  const list = (await get(`${app(J)}/api/messages`)).filter((x) => x.transactionId === tx && x.action === 'on_status');
  const done = list.map((x) => beckn.readContract(x.body.message)).find((c) => c.data.state === 'COMPLETED');
  check('Journey gets on_status COMPLETED (contract COMPLETE)', done && done.status === 'COMPLETE', JSON.stringify(list.map((x) => beckn.readContract(x.body.message).data.state)));

  // Status query.
  await send('status', W, tx, contract(order.id, W, offer, 'ACTIVE'));
  await sleep(800);
  const all = (await get(`${app(J)}/api/messages`)).filter((x) => x.transactionId === tx && x.action === 'on_status');
  check('status query is answered with the current state', all.length >= 3, `${all.length} on_status`);

  // Every answer WeHelp sent was ACKed by Journey's adapter.
  const out = (await get(`${app(W)}/api/messages?transactionId=${tx}`)).filter((x) => x.direction === 'out');
  check('every answer WeHelp sent got Journey\'s signed ACK', out.length >= 6 && out.every((x) => x.ack === 'ACK'), JSON.stringify(out.map((x) => `${x.action}:${x.ack}:${x.error || ''}`)));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
