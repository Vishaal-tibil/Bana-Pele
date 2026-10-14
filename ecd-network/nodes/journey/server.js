// Journey Platform node app (BAP). It stands in for My Journey until Elevate's
// network-kit.js talks to this node's ONIX adapter itself (plan, phase 6).
//   Front Door + Journey Registry   register Naledi, her requests
//   Consent & Permission            she ticks what the chosen provider may see
//   Network Integration             discover to every member provider, rank
//                                   the answers, select/init/confirm, status
//   Observability                   /monitor: members, health, every message
// All network traffic goes through this node's own ONIX adapter.
//
//   NODE_FILE=config/nodes/journey.json node nodes/journey/server.js

'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const kit = require('../../lib/kit');
const beckn = require('../../lib/beckn');
const { addresses } = require('../../lib/addresses');

const ROOT = path.resolve(__dirname, '../..');
const { node, network, addr, hookRoute } = kit.loadNode();
const SVC = `${node.id}-app`;
const seed = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'seed/elevate', f), 'utf8'));
const NEEDS = seed('needs.json');
const CONSENT = seed('consent.json');
const PEOPLE = seed('people.json');
const SHAREABLE = CONSENT.shareableFields.map((f) => f.field);

const db = kit.store(node.id, { naledis: [], sessions: {}, requests: [] });
const msgs = kit.messageLog(db, 1000);
const S = db.state;
const now = () => new Date().toISOString();
const id = (p) => `${p}-${crypto.randomBytes(4).toString('hex')}`;

// ---------------------------------------------------------------- helpers
function cookie(req, name) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|; )${name}=([a-f0-9]{48})`));
  return m && m[1];
}
function me(req) {
  const sid = cookie(req, 'sid');
  const nid = sid && S.sessions[sid];
  return nid ? S.naledis.find((n) => n.id === nid) : null;
}
function requireJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('JSON only'), { status: 415 });
}
function clean(v, max) { return String(v || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
function step(r, text) { r.timeline.push({ at: now(), text }); r.updatedAt = now(); }
function view(r) {
  const { naledi, transactionId, ...rest } = r;
  return { ...rest, transactionId, needLabel: NEEDS.labels[r.needType] || r.needType };
}

async function send(r, action, provider, message, messageId) {
  const ctx = kit.context(network, action, {
    bapId: node.subscriberId, bapUri: addr.receiver,
    bppId: provider.subscriberId, bppUri: provider.url,
    transactionId: r.transactionId, messageId,
  });
  const body = { context: ctx, message };
  const res = await kit.callAdapter(addr, action, body);
  msgs.add({ direction: 'out', action, transactionId: r.transactionId, messageId: ctx.messageId, to: provider.subscriberId, ack: res.ack, error: res.error, body });
  return res;
}

function chosenProvider(r) { return r.chosen && { subscriberId: r.chosen.providerId, url: r.chosen.bppUri }; }
function contractOut(r, status, kind, data) {
  return beckn.contractMessage({
    id: (r.order && r.order.id) || `contract-${r.id}`, providerId: r.chosen.providerId, providerName: r.chosen.providerName,
    needType: r.needType, offerId: r.chosen.offerId, offerTitle: r.chosen.title, contractStatus: status, kind, data,
  });
}

// Ranking: more reasons first; a provider that serves her locality by name
// (the first part of her region, e.g. "Alexandra") before one that serves
// only her province. Ties by name, so the order is stable.
function rank(r) {
  const locality = String(r.region).split(',')[0].trim().toLowerCase();
  const score = (a) => a.why.length * 10 + (a.why.some((w) => w.toLowerCase() === `serves ${locality}`) ? 5 : 0);
  r.answers.sort((a, b) => score(b) - score(a) || a.providerName.localeCompare(b.providerName));
  r.answers.forEach((a, i) => { a.rank = i + 1; });
}

function find(ctx, needStatusFrom) {
  const r = S.requests.find((x) => x.transactionId === ctx.transactionId);
  if (!r) { kit.log(SVC, 'warn', 'answer for an unknown request', { transactionId: ctx.transactionId }); return null; }
  if (needStatusFrom && (!r.chosen || r.chosen.providerId !== ctx.bppId)) {
    kit.log(SVC, 'warn', 'answer from a provider she did not choose', { bppId: ctx.bppId }); return null;
  }
  return r;
}

// ---------------------------------------------------------------- Beckn answers
const handlers = {
  async on_discover(body) {
    const ctx = body.context; const r = find(ctx);
    if (!r || !r.asked.some((a) => a.providerId === ctx.bppId)) return;
    for (const c of beckn.readCatalogs(body.message)) {
      if (c.providerId !== ctx.bppId || r.answers.some((a) => a.offerId === c.offerId)) continue;
      r.answers.push({ ...c, bppUri: r.asked.find((a) => a.providerId === ctx.bppId).bppUri, at: now() });
      step(r, `${c.providerName} can help: ${c.title}`);
    }
    rank(r);
    if (['ASKING', 'NO_ANSWER'].includes(r.status)) r.status = 'ANSWERS_IN';
    db.save();
  },
  async on_select(body) {
    const r = find(body.context, true); if (!r || r.status !== 'BOOKING') return;
    step(r, `${r.chosen.providerName} confirmed the offer`);
    // init: the only message that carries her details, and only what she ticked.
    const shared = { sharedFields: r.consent.fields, region: r.region };
    const n = S.naledis.find((x) => x.id === r.naledi);
    for (const f of r.consent.fields) shared[f] = n[f];
    const res = await send(r, 'init', chosenProvider(r), contractOut(r, 'DRAFT', 'shared-details', shared));
    if (!res.ok && r.status === 'BOOKING') { step(r, `Could not send her details: ${res.error || res.ack}`); r.status = 'FAILED'; }
    db.save();
  },
  async on_init(body) {
    const r = find(body.context, true); if (!r || r.status !== 'BOOKING') return;
    const res = await send(r, 'confirm', chosenProvider(r), contractOut(r, 'ACTIVE'));
    if (!res.ok && r.status === 'BOOKING') { step(r, `Could not book: ${res.error || res.ack}`); r.status = 'FAILED'; }
    db.save();
  },
  async on_confirm(body) { applyOrder(body, 'booked'); },
  async on_status(body) { applyOrder(body, 'status'); },
};

const FINAL = ['DECLINED', 'COMPLETED'];
function applyOrder(body, why) {
  const r = find(body.context, true); if (!r) return;
  const c = beckn.readContract(body.message);
  const state = c.data && c.data.state;
  if (!['PENDING', 'ACCEPTED', 'DECLINED', 'COMPLETED'].includes(state)) return;
  const at = String((c.data && c.data.updatedAt) || now());
  // Answers can cross on the network: never let an older state replace a
  // newer one, and never leave a final state.
  if (r.order && (FINAL.includes(r.order.state) || at < r.order.updatedAt)) return;
  const before = r.order && r.order.state;
  r.order = { id: c.id, state, coach: c.coach || (c.data && c.data.coach) || null, updatedAt: at };
  r.status = state;
  if (before !== state) {
    const name = r.chosen.providerName;
    step(r, {
      PENDING: `Booked with ${name}, waiting for their team`,
      ACCEPTED: `${name} accepted. Your coach is ${r.order.coach}`,
      DECLINED: `${name} could not take this on`,
      COMPLETED: `${name} marked the support as delivered`,
    }[state]);
  } else if (why === 'status') r.updatedAt = now();
  db.save();
}

// Nothing waits forever: no answers in ASK_MS, or no booking in BOOK_MS, ends
// the step so Naledi can ask again or choose another provider.
const ASK_MS = Number(process.env.ECD_ASK_TIMEOUT_MS || 20000);
const BOOK_MS = Number(process.env.ECD_BOOK_TIMEOUT_MS || 30000);
setInterval(() => {
  const t = Date.now(); let changed = false;
  for (const r of S.requests) {
    const age = t - Date.parse(r.updatedAt);
    if (r.status === 'ASKING' && age > ASK_MS) { r.status = 'NO_ANSWER'; step(r, 'No provider could help with this'); changed = true; }
    if (r.status === 'BOOKING' && age > BOOK_MS) { r.status = 'FAILED'; step(r, `${r.chosen.providerName} did not finish the booking`); changed = true; }
  }
  if (changed) db.save();
}, 2000).unref();

// ---------------------------------------------------------------- API
async function register(req, res) {
  requireJson(req);
  const b = await kit.readJson(req, 4096);
  const n = { id: id('naledi'), name: clean(b.name, 80), centre: clean(b.centre, 120), region: clean(b.region, 100), phone: clean(b.phone, 30), registeredAt: now() };
  if (!n.name || !n.region) return kit.send(res, 400, { error: 'name and region are needed' });
  if (n.phone && !/^\+?[0-9 ()-]{6,30}$/.test(n.phone)) return kit.send(res, 400, { error: 'phone looks wrong' });
  S.naledis.push(n);
  const sid = crypto.randomBytes(24).toString('hex');
  S.sessions[sid] = n.id; db.save();
  kit.send(res, 201, n, { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
}

async function ask(req, res) {
  requireJson(req);
  const n = me(req); if (!n) return kit.send(res, 401, { error: 'register first' });
  const b = await kit.readJson(req, 1024);
  if (!NEEDS.labels[b.needType]) return kit.send(res, 400, { error: 'unknown need type' });
  const r = { id: id('req'), naledi: n.id, transactionId: crypto.randomUUID(), needType: b.needType, region: n.region,
    status: 'ASKING', asked: [], answers: [], chosen: null, consent: null, order: null, createdAt: now(), updatedAt: now(), timeline: [] };
  step(r, `Asked the network for ${NEEDS.labels[b.needType].toLowerCase()}`);
  S.requests.push(r); db.save();
  kit.send(res, 202, view(r));
  // Every live provider in our registry is asked; each decides for itself.
  let providers = [];
  try { providers = await kit.registryMembers(addr, 'BPP'); } catch (e) { step(r, `Could not reach the registry: ${e.message}`); r.status = 'FAILED'; db.save(); return; }
  // Recorded before sending: an answer can arrive before the ACK does.
  for (const p of providers) r.asked.push({ providerId: p.subscriber_id, name: p.name, bppUri: p.url, ack: null, error: null });
  await Promise.all(providers.map(async (p) => {
    const res2 = await send(r, 'discover', { subscriberId: p.subscriber_id, url: p.url }, beckn.discoverMessage({ needType: r.needType, region: r.region }));
    Object.assign(r.asked.find((a) => a.providerId === p.subscriber_id), { ack: res2.ack, error: res2.error });
  }));
  if (!providers.length && r.status === 'ASKING') { r.status = 'NO_ANSWER'; step(r, 'No providers are in the network right now'); }
  step(r, `Asked ${providers.length} provider${providers.length === 1 ? '' : 's'}`);
  db.save();
}

async function accept(req, res, m) {
  requireJson(req);
  const n = me(req); if (!n) return kit.send(res, 401, { error: 'register first' });
  const r = S.requests.find((x) => x.id === m[1] && x.naledi === n.id);
  if (!r) return kit.send(res, 404, { error: 'no such request' });
  const b = await kit.readJson(req, 2048);
  const a = r.answers.find((x) => x.offerId === b.offerId);
  if (!a) return kit.send(res, 409, { error: 'that offer is not one of the answers' });
  if (r.chosen && !['FAILED', 'DECLINED'].includes(r.status)) return kit.send(res, 409, { error: 'already chosen' });
  if (r.chosen && r.chosen.providerId === a.providerId) return kit.send(res, 409, { error: 'choose a different provider' });
  if (r.chosen) { r.order = null; step(r, `Choosing again after ${r.chosen.providerName}`); }
  const fields = (Array.isArray(b.share) ? b.share : []).filter((f) => SHAREABLE.includes(f));
  r.chosen = { providerId: a.providerId, providerName: a.providerName, offerId: a.offerId, title: a.title, bppUri: a.bppUri };
  r.consent = { fields: [...new Set(fields)], grantee: a.providerId, at: now() };
  r.status = 'BOOKING';
  step(r, `Chose ${a.providerName} and agreed to share: ${r.consent.fields.length ? r.consent.fields.join(', ') : 'nothing personal'}`);
  db.save();
  const res2 = await send(r, 'select', chosenProvider(r), contractOut(r, 'DRAFT'));
  if (!res2.ok && r.status === 'BOOKING') { step(r, `Could not reach ${a.providerName}: ${res2.error || res2.ack}`); r.status = 'FAILED'; db.save(); }
  kit.send(res, 202, view(r));
}

async function refresh(req, res, m) {
  requireJson(req);
  const n = me(req); if (!n) return kit.send(res, 401, { error: 'register first' });
  const r = S.requests.find((x) => x.id === m[1] && x.naledi === n.id);
  if (!r) return kit.send(res, 404, { error: 'no such request' });
  if (!r.order) return kit.send(res, 409, { error: 'nothing booked yet' });
  const res2 = await send(r, 'status', chosenProvider(r), contractOut(r, 'ACTIVE'));
  kit.send(res, 202, { sent: res2.ok, error: res2.ok ? undefined : res2.error });
}

// Observability: members from the registry, health of each node's app and
// adapter, and every node's message log merged.
function appUrl(n) { const a = addresses(n, network); return a.mode === 'docker' ? `http://${n.id}-app:${n.ports.app}` : `http://127.0.0.1:${n.ports.app}`; }
function nodeFiles() {
  const dir = path.join(ROOT, 'config/nodes');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}
async function up(url) { try { await fetch(url, { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; } }
async function networkView(req, res) {
  let members = [];
  try { members = (await (await fetch(`${addr.registry}/subscribers?all=1`, { signal: AbortSignal.timeout(3000) })).json()).subscribers; } catch { /* registry down */ }
  const files = nodeFiles();
  const out = await Promise.all(members.map(async (m) => {
    const f = files.find((x) => x.subscriberId === m.subscriber_id);
    return {
      subscriberId: m.subscriber_id, name: m.name, type: m.type, url: m.url, keyId: m.key_id,
      state: m.status === 'SUBSCRIBED' ? 'live' : 'paused',
      adapterUp: await up(m.url.replace(/\/(bap|bpp)\/receiver$/, '/')),
      appUp: f ? await up(`${appUrl(f)}/health`) : null,
    };
  }));
  kit.send(res, 200, { networkId: network.networkId, registryUp: members.length > 0, members: out, checkedAt: now() });
}
async function networkMessages(req, res, m, url) {
  const tx = url.searchParams.get('transactionId');
  const all = await Promise.all(nodeFiles().map(async (f) => {
    try {
      const list = await (await fetch(`${appUrl(f)}/api/messages${tx ? `?transactionId=${encodeURIComponent(tx)}` : ''}`, { signal: AbortSignal.timeout(2000) })).json();
      return list.map(({ body, ...x }) => ({ ...x, node: f.subscriberId }));
    } catch { return []; }
  }));
  kit.send(res, 200, all.flat().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 300));
}

// ---------------------------------------------------------------- routes
const PUBLIC = path.join(__dirname, 'public');
kit.serve(node.ports.app, [
  ['GET', /^\/$/, (q, s) => kit.serveFile(s, PUBLIC, 'index.html')],
  ['GET', /^\/monitor$/, (q, s) => kit.serveFile(s, PUBLIC, 'monitor.html')],
  ['GET', /^\/(app\.js|monitor\.js)$/, (q, s, m) => kit.serveFile(s, PUBLIC, m[1])],
  ['GET', /^\/ui\/([a-z.-]+)$/, (q, s, m) => kit.serveFile(s, path.join(ROOT, 'ui'), m[1])],
  ['GET', /^\/health$/, (q, s) => kit.send(s, 200, { ok: true, id: node.subscriberId, role: node.role, name: node.name, requests: S.requests.length, messages: S.messages.length })],
  ['POST', hookRoute, kit.webhookHandler({ db, msgs, service: SVC, handlers })],
  ['GET', /^\/api\/options$/, (q, s) => kit.send(s, 200, {
    needs: Object.entries(NEEDS.labels).map(([value, label]) => ({ value, label })),
    share: CONSENT.shareableFields,
    regions: ['Alexandra, Gauteng', 'Soweto, Gauteng', 'Bushbuckridge, Mpumalanga'],
    demo: { ...PEOPLE.practitioners[0], centre: 'Little Stars ELC' },
  })],
  ['POST', /^\/api\/naledis$/, register],
  // 200 either way, so a first visit does not log an error in the browser.
  ['GET', /^\/api\/me$/, (q, s) => { const n = me(q); kit.send(s, 200, n ? { registered: true, ...n } : { registered: false }); }],
  ['POST', /^\/api\/requests$/, ask],
  ['GET', /^\/api\/requests$/, (q, s) => { const n = me(q); if (!n) return kit.send(s, 401, { error: 'register first' }); kit.send(s, 200, S.requests.filter((r) => r.naledi === n.id).reverse().map(view)); }],
  ['POST', /^\/api\/requests\/(req-[a-f0-9]+)\/accept$/, accept],
  ['POST', /^\/api\/requests\/(req-[a-f0-9]+)\/refresh$/, refresh],
  ['GET', /^\/api\/network$/, networkView],
  ['GET', /^\/api\/network\/messages$/, networkMessages],
  ['GET', /^\/api\/messages$/, (q, s, m, url) => kit.send(s, 200, msgs.list({ transactionId: url.searchParams.get('transactionId') }))],
], SVC);
