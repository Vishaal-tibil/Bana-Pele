// Provider node app (BPP) -- run once per provider (WeHelp, GROW, ...), each
// with its own node file, keys, adapter and data. It
//   - receives Beckn requests from its own ONIX adapter at /beckn/hook-<secret>/<action>
//   - decides with its own rules (its Elevate org profile) whether it can help
//   - answers through its own adapter's caller (on_discover ... on_status)
//   - serves its staff dashboard and the API behind it.
//
//   NODE_FILE=config/nodes/wehelp.json node nodes/provider/server.js

'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const kit = require('../../lib/kit');
const beckn = require('../../lib/beckn');
const { matchProfile } = require('../../lib/match');

const ROOT = path.resolve(__dirname, '../..');
const { node, network, addr, hookRoute } = kit.loadNode();
const SVC = `${node.id}-app`;
const seed = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'seed/elevate', f), 'utf8'));
const NEEDS = seed('needs.json');
const org = seed('org_profiles.json').profiles.find((p) => p.provider_id === node.provider.elevateProviderId);
if (!org) throw new Error(`no Elevate org profile ${node.provider.elevateProviderId}`);
const people = seed('people.json');
const coaches = people.coaches.filter((c) => c.org.toLowerCase() === org.name.toLowerCase()).map((c) => c.name);
const OFFER = { id: `${node.id}-${slug(node.provider.offer.title)}`, ...node.provider.offer };

const db = kit.store(node.id, { orders: [], bookings: {}, asked: [] });
const msgs = kit.messageLog(db);
const S = db.state;

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function now() { return new Date().toISOString(); }

// ---------------------------------------------------------------- sending answers
async function answer(action, reqCtx, message, { unsolicited = false } = {}) {
  const ctx = kit.context(network, action, {
    bapId: reqCtx.bapId, bapUri: reqCtx.bapUri,
    bppId: node.subscriberId, bppUri: addr.receiver,
    transactionId: reqCtx.transactionId,
    messageId: unsolicited ? crypto.randomUUID() : reqCtx.messageId,
  });
  const body = { context: ctx, message };
  const r = await kit.callAdapter(addr, action, body);
  msgs.add({ direction: 'out', action, transactionId: ctx.transactionId, messageId: ctx.messageId, to: ctx.bapId, ack: r.ack, error: r.error, body });
  if (!r.ok) kit.log(SVC, 'warn', 'answer not accepted', { action, status: r.status, error: r.error });
  return r;
}

// Only a BAP that is a live member of our network may ask. The adapter has
// already checked the signature; this checks the asker's role.
async function isMemberBap(bapId) {
  try { return (await kit.registryMembers(addr, 'BAP')).some((m) => m.subscriber_id === bapId); } catch { return false; }
}

function contractFor(order, contractStatus, kind, data) {
  return beckn.contractMessage({
    id: order.id, providerId: node.subscriberId, providerName: node.name,
    needType: order.needType, offerId: order.offerId, offerTitle: order.offerTitle,
    contractStatus, kind, data, coach: order.coach,
  });
}

function orderState(order) { return { orderId: order.id, state: order.state, coach: order.coach || null, updatedAt: order.updatedAt }; }

// ---------------------------------------------------------------- Beckn handlers
const handlers = {
  async discover(body) {
    const ctx = body.context;
    if (!(await isMemberBap(ctx.bapId))) return kit.log(SVC, 'warn', 'discover from a non-member BAP ignored', { bapId: ctx.bapId });
    const intent = beckn.readIntent(body.message);
    const m = matchProfile(intent, org.profile, NEEDS.areas);
    S.asked.push({ at: now(), transactionId: ctx.transactionId, needType: intent.needType, region: intent.region, answered: m.match, reasons: m.reasons });
    if (S.asked.length > 200) S.asked.shift();
    db.save();
    if (!m.match) return; // cannot help: stay silent, as Beckn allows
    await answer('on_discover', ctx, beckn.catalogMessage({
      providerId: node.subscriberId, providerName: node.name, description: org.profile.about.description,
      bppUri: addr.receiver, offer: OFFER, why: m.reasons, needType: intent.needType, region: intent.region,
    }));
  },

  async select(body) {
    const ctx = body.context; const c = beckn.readContract(body.message);
    if (!(await isMemberBap(ctx.bapId))) return kit.log(SVC, 'warn', 'select from a non-member BAP ignored', { bapId: ctx.bapId });
    const prior = S.bookings[ctx.transactionId];
    if (prior && prior.bapId !== ctx.bapId) return kit.log(SVC, 'warn', 'select for another BAP\'s transaction ignored', { bapId: ctx.bapId });
    if (c.offerId !== OFFER.id) return kit.log(SVC, 'warn', 'select for an unknown offer', { offerId: c.offerId });
    S.bookings[ctx.transactionId] = { ...(S.bookings[ctx.transactionId] || {}), offerId: c.offerId, needType: c.needType, bapId: ctx.bapId, bapUri: ctx.bapUri, selectedAt: now() };
    db.save();
    await answer('on_select', ctx, beckn.contractMessage({
      id: c.id, providerId: node.subscriberId, providerName: node.name, needType: c.needType,
      offerId: OFFER.id, offerTitle: OFFER.title, contractStatus: 'DRAFT', kind: 'terms', data: { terms: OFFER.terms },
    }));
  },

  async init(body) {
    const ctx = body.context; const c = beckn.readContract(body.message);
    const b = S.bookings[ctx.transactionId];
    if (!b || c.offerId !== OFFER.id || b.bapId !== ctx.bapId) return kit.log(SVC, 'warn', 'init without a matching select', { transactionId: ctx.transactionId });
    // Keep only the fields she agreed to share, and only those listed.
    const shared = c.kind === 'shared-details' ? c.data : {};
    const fields = (Array.isArray(shared.sharedFields) ? shared.sharedFields : []).filter((f) => ['name', 'centre', 'phone'].includes(f));
    b.customer = { sharedFields: fields, ...Object.fromEntries(fields.filter((f) => typeof shared[f] === 'string').map((f) => [f, shared[f].slice(0, 200)])) };
    b.region = typeof shared.region === 'string' ? shared.region.slice(0, 100) : b.region;
    db.save();
    await answer('on_init', ctx, beckn.contractMessage({
      id: c.id, providerId: node.subscriberId, providerName: node.name, needType: c.needType,
      offerId: OFFER.id, offerTitle: OFFER.title, contractStatus: 'DRAFT', kind: 'terms', data: { terms: OFFER.terms, accepted: true },
    }));
  },

  async confirm(body) {
    const ctx = body.context; const c = beckn.readContract(body.message);
    const b = S.bookings[ctx.transactionId];
    if (!b || !b.customer || b.bapId !== ctx.bapId) return kit.log(SVC, 'warn', 'confirm without a matching init', { transactionId: ctx.transactionId });
    let order = S.orders.find((o) => o.transactionId === ctx.transactionId);
    if (!order) {
      order = {
        id: `ord-${crypto.randomBytes(4).toString('hex')}`, transactionId: ctx.transactionId,
        bapId: ctx.bapId, bapUri: ctx.bapUri, needType: c.needType || b.needType, region: b.region || '',
        offerId: OFFER.id, offerTitle: OFFER.title, customer: b.customer, state: 'PENDING', coach: null,
        createdAt: now(), updatedAt: now(), history: [{ at: now(), text: 'Booked by the Journey Platform' }],
      };
      S.orders.push(order); db.save();
    }
    await answer('on_confirm', ctx, contractFor(order, 'ACTIVE', 'order-state', orderState(order)));
  },

  async status(body) {
    const ctx = body.context; const c = beckn.readContract(body.message);
    const order = S.orders.find((o) => o.id === c.id && o.transactionId === ctx.transactionId && o.bapId === ctx.bapId);
    if (!order) return kit.log(SVC, 'warn', 'status for an unknown order', { id: c.id });
    await answer('on_status', ctx, contractFor(order, statusOf(order), 'order-state', orderState(order)));
  },
};

function statusOf(order) { return { PENDING: 'ACTIVE', ACCEPTED: 'ACTIVE', DECLINED: 'CANCELLED', COMPLETED: 'COMPLETE' }[order.state]; }

// ---------------------------------------------------------------- staff actions
async function act(req, res, m, change) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return kit.send(res, 415, { error: 'JSON only' });
  const input = await kit.readJson(req, 4096);
  const order = S.orders.find((o) => o.id === m[1]);
  if (!order) return kit.send(res, 404, { error: 'no such order' });
  const err = change(order, input);
  if (err) return kit.send(res, 409, { error: err });
  order.updatedAt = now(); db.save();
  const reqCtx = { bapId: order.bapId, bapUri: order.bapUri, transactionId: order.transactionId };
  const r = await answer('on_status', reqCtx, contractFor(order, statusOf(order), 'order-state', orderState(order)), { unsolicited: true });
  kit.send(res, 200, { order, delivered: r.ok, error: r.ok ? undefined : r.error });
}

// ---------------------------------------------------------------- routes
const PUBLIC = path.join(__dirname, 'public');
const UI = path.join(ROOT, 'ui');
kit.serve(node.ports.app, [
  ['GET', /^\/$/, (q, s) => kit.serveFile(s, PUBLIC, 'index.html')],
  ['GET', /^\/(app\.js)$/, (q, s, m) => kit.serveFile(s, PUBLIC, m[1])],
  ['GET', /^\/ui\/([a-z.-]+)$/, (q, s, m) => kit.serveFile(s, UI, m[1])],
  ['GET', /^\/health$/, (q, s) => kit.send(s, 200, { ok: true, id: node.subscriberId, role: node.role, name: node.name, orders: S.orders.length, messages: S.messages.length })],
  ['POST', hookRoute, kit.webhookHandler({ db, msgs, service: SVC, handlers })],
  ['GET', /^\/api\/profile$/, (q, s) => kit.send(s, 200, {
    id: node.subscriberId, name: node.name, about: org.profile.about, capabilities: org.profile.capabilities,
    coverage: org.profile.coverage, needTypes: org.profile.capabilities.map((c) => NEEDS.areas[c.area]).filter(Boolean),
    offer: OFFER, coaches, source: org.provider_id,
  })],
  ['GET', /^\/api\/orders$/, (q, s) => kit.send(s, 200, S.orders.slice().reverse())],
  ['GET', /^\/api\/asked$/, (q, s) => kit.send(s, 200, S.asked.slice().reverse())],
  ['GET', /^\/api\/messages$/, (q, s, m, url) => kit.send(s, 200, msgs.list({ transactionId: url.searchParams.get('transactionId') }))],
  ['POST', /^\/api\/orders\/([a-z0-9-]+)\/accept$/, (q, s, m) => act(q, s, m, (o, input) => {
    if (o.state !== 'PENDING') return 'only a new order can be accepted';
    const coach = String(input.coach || '').trim().slice(0, 80);
    if (!coach) return 'name the coach';
    o.state = 'ACCEPTED'; o.coach = coach; o.history.push({ at: now(), text: `Accepted, coach ${coach}` });
  })],
  ['POST', /^\/api\/orders\/([a-z0-9-]+)\/decline$/, (q, s, m) => act(q, s, m, (o) => {
    if (o.state !== 'PENDING') return 'only a new order can be declined';
    o.state = 'DECLINED'; o.history.push({ at: now(), text: 'Declined' });
  })],
  ['POST', /^\/api\/orders\/([a-z0-9-]+)\/complete$/, (q, s, m) => act(q, s, m, (o) => {
    if (o.state !== 'ACCEPTED') return 'only an accepted order can be completed';
    o.state = 'COMPLETED'; o.history.push({ at: now(), text: 'Support delivered' });
  })],
], SVC);
