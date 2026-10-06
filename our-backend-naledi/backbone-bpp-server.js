// backbone-bpp-server.js
//
// The "Digital Backbone" from both use case docs -- combines:
//   Use Case 1 (NGO Support Network): tracks NEEDS per Naledi, prevents
//   two providers reserving/fulfilling the same need (deduplication).
//   Use Case 2 (Naledi Discovers the Right Thabo): tracks PROVIDERS
//   (NGOs and "Thabos" are modeled the same way -- both are just
//   "providers" who cover certain need types in certain regions) and
//   lets a front door discover which ones match a given need.
//
// This is v1 scope, deliberately smaller than the full docs:
//   INCLUDED: provider registration, discover (by need type + region,
//   with dedup status shown), select/reserve, init (accept/decline),
//   confirm (record fulfilment + a journey note).
//   NOT YET INCLUDED (real gaps, same honesty as the rest of this
//   project): free-text need description / NLU, subscribe+notify,
//   permissioned/pseudonymous visibility, peer-guide verification,
//   ecosystem-wide reporting.
//
// Follows the exact same Beckn action pattern as course-bpp-server.js:
// discover / select / init / confirm come in as POST /api/webhook/<action>,
// and this server sends back on_<action> callbacks asynchronously.

const http = require('http');
const crypto = require('crypto');
const { createLogger } = require('./logger');
const { openPool } = require('./db');

const log = createLogger(process.env.SERVICE_NAME || 'sandbox-bpp');
const pool = openPool(log);
log.attachDb(pool);

const PORT = process.env.PORT || 4001;
// Same "direct mode" pattern as course-bpp-server.js -- see that file's
// comments for why this isn't going through a real onix-bpp relay yet.
const ONIX_CALLER = process.env.ONIX_CALLER || 'http://localhost:4000/api/bap-webhook';

// ---- Data model ----
// A "need" belongs to one Naledi, has a type, and a status.
// A "provider" is either an NGO or a "Thabo" -- modeled identically,
// since the docs describe them as the same kind of actor wearing
// different labels.

const NEED_TYPES = [
  'starter-kit',
  'registration',
  'capability-development',
  'fundraising',
  'infrastructure',
  'peer-guidance',
  // Support areas used by the My Journey demo (WeHelp's capabilities).
  'learning-skilling',
  'health-safety',
  'nutrition',
  'child-development',
];

const naledis = new Map(); // id -> { id, name, region, needIds: [] }
const needs = new Map(); // id -> { id, naledisId, type, status, providerId, note }
const providers = new Map(); // id -> { id, name, kind, needTypesCovered, region, capacity, description }
const pendingRequests = []; // { id, action, context, message, needId, providerId }

function id(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

// ---- Seed data, matching the examples in both use-case docs ----

function seed() {
  const ngoSmartStart = { id: 'provider-smartstart', name: 'SmartStart', kind: 'NGO', needTypesCovered: ['starter-kit'], region: 'Gauteng', capacity: 'Open', description: 'Starter-kit provision for newly registered ELPs.' };
  const ngoGrow = { id: 'provider-grow', name: 'GROW', kind: 'NGO', needTypesCovered: ['fundraising'], region: 'Gauteng', capacity: 'Open', description: 'Business-development and sustainability support.' };
  const ngoImpande = { id: 'provider-impande', name: 'Impande', kind: 'NGO', needTypesCovered: ['registration'], region: 'Gauteng', capacity: 'Open', description: 'Registration and municipal-compliance assistance.' };
  const thaboRegistration = { id: 'provider-thabo-registration', name: 'Registration Guide Thabo', kind: 'Thabo', needTypesCovered: ['registration'], region: 'Gauteng', capacity: 'Open', description: 'Registration, compliance and municipal navigation.' };
  const thaboCapability = { id: 'provider-thabo-capability', name: 'Capability Development Thabo', kind: 'Thabo', needTypesCovered: ['capability-development'], region: 'Gauteng', capacity: 'Open', description: 'Teaching quality, curriculum and practitioner development.' };
  const thaboFundraising = { id: 'provider-thabo-fundraising', name: 'Fundraising Thabo', kind: 'Thabo', needTypesCovered: ['fundraising'], region: 'Gauteng', capacity: 'Open', description: 'Funding discovery, applications and business sustainability.' };
  const peerGuide = { id: 'provider-peer-guide', name: 'Peer Naledi Guide', kind: 'Thabo', needTypesCovered: ['peer-guidance'], region: 'Gauteng', capacity: 'Open', description: 'Practical guidance based on lived ELP experience.' };

  // WeHelp, as described in the My Journey demo script: Johannesburg NGO
  // covering Alexandra, with registration and infrastructure support.
  const ngoWeHelp = {
    id: 'provider-wehelp', name: 'WeHelp', kind: 'NGO',
    needTypesCovered: ['registration', 'infrastructure', 'learning-skilling', 'health-safety', 'nutrition', 'child-development'],
    region: 'Alexandra', coverage: ['Gauteng', 'Johannesburg', 'Alexandra'], capacity: 'Open',
    description: 'Registration guidance, DSD submission support and infrastructure help for ELPs in Alexandra.',
  };

  [ngoSmartStart, ngoGrow, ngoImpande, thaboRegistration, thaboCapability, thaboFundraising, peerGuide, ngoWeHelp].forEach((p) =>
    providers.set(p.id, p)
  );

  const naledi = { id: 'naledi-001', name: 'Naledi (demo)', region: 'Gauteng', needIds: [] };
  naledis.set(naledi.id, naledi);

  // One need per category the built-in page offers, so every category has
  // something to select against.
  ['starter-kit', 'registration', 'capability-development', 'fundraising', 'infrastructure', 'peer-guidance'].forEach((type) => {
    const need = { id: id('need'), naledisId: naledi.id, type, status: 'open', providerId: null, note: '' };
    needs.set(need.id, need);
    naledi.needIds.push(need.id);
  });
}
seed();

// ---- helpers ----

function needsForNaledi(naledisId) {
  const naledi = naledis.get(naledisId);
  if (!naledi) return [];
  return naledi.needIds.map((nid) => needs.get(nid)).filter(Boolean);
}

// A provider matches a region when it is registered there or lists it in its
// coverage (WeHelp, for example, is in Alexandra and also covers Gauteng).
function providersMatching(needType, region) {
  const want = String(region || '').toLowerCase();
  return [...providers.values()].filter(
    (p) =>
      p.needTypesCovered.includes(needType) &&
      (!want || String(p.region).toLowerCase() === want || (p.coverage || []).some((c) => String(c).toLowerCase() === want))
  );
}

// Note: callback contexts are built by spreading the *incoming*
// request's context (see handleAction/resolvePending below), not a
// separate buildContext() here -- so they automatically inherit
// bapUri/bppUri from whatever the BAP sent, including the real ONIX
// routing fields once frontdoor-bap-server.js supplies them.

// Resolves to { ok, status, text } (or { ok:false, error }) so callers can
// tell when the adapter refused the message (schema or signing failure).
function sendCallback(callback) {
  const url = `${ONIX_CALLER}/${callback.context.action}`;
  const c = callback.context;
  log.message('out', callback, { to: 'onix-bpp' });
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(callback),
  })
    .then(async (res) => {
      const text = await res.text().catch(() => '');
      const ok = res.ok && !text.includes('"NACK"');
      log[ok ? 'info' : 'warn']('beckn.ack', { transactionId: c.transactionId, messageId: c.messageId, action: c.action, from: 'onix-bpp', httpStatus: res.status, ack: ok ? 'ACK' : 'NACK', body: text.slice(0, 2000) });
      return { ok, status: res.status, text };
    })
    .catch((err) => {
      log.error('beckn.send_failed', { transactionId: c.transactionId, messageId: c.messageId, action: c.action, to: 'onix-bpp', error: err.message, cause: err.cause && String(err.cause) });
      return { ok: false, status: 0, error: err.message };
    });
}

// Answers a select/confirm straight away with REJECTED (used when the need is
// unknown, already reserved by someone else, or not in a state that allows it).
function rejectNow(context, needId, providerId, action) {
  log.info('request.rejected', { transactionId: context.transactionId, needId, providerId, stage: action === 'on_init' ? 'select' : 'confirm', reason: 'need not available' });
  return sendCallback({
    context: { ...context, action, timestamp: new Date().toISOString() },
    message: { contract: buildContractResponse(needId, providerId, 'REJECTED') },
  });
}

// Provider-side layer for the My Journey integration (see v1-bpp.js).
const v1 = require('./v1-bpp')({
  log, pool,
  providers, naledis, needs, pendingRequests, NEED_TYPES,
  seed, sendCallback, providersMatching,
  resolvePending: (pendingId, approved) => resolvePending(pendingId, approved),
});
// Loaded before the server starts listening (see the bottom of this file).
const started = v1.ready.then(() => {
  v1.restore(); // if a saved state exists, it replaces the freshly seeded data
  v1.persist();
});

// ---- HTTP server ----

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace(/\/$/, '');

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Save state after any write (approve / reject / register / webhook).
  if (req.method === 'POST') res.on('finish', () => v1.persist());

  // Internal endpoints used by the buyer app's /v1/provider/* relay.
  if (v1.handle(req, res, path)) return;

  if (req.method === 'GET' && path === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Full readable state -- naledis, needs, providers, pending requests.
  // Used by the front door AND by any admin/demo UI.
  if (req.method === 'GET' && path === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        naledis: [...naledis.values()].map((n) => ({ ...n, needs: needsForNaledi(n.id) })),
        providers: [...providers.values()],
        pending: pendingRequests,
      })
    );
    return;
  }

  // A provider (NGO or Thabo) registers itself. Matches "Each
  // participating NGO registers a verified network profile" /
  // "Different Thabos establish their network presence".
  if (req.method === 'POST' && path === '/api/register-provider') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const p = JSON.parse(body);
        const provider = {
          id: id('provider'),
          name: p.name,
          kind: p.kind || 'NGO',
          needTypesCovered: p.needTypesCovered || [],
          region: p.region || 'Gauteng',
          capacity: p.capacity || 'Open',
          description: p.description || '',
        };
        providers.set(provider.id, provider);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(provider));
      } catch (e) {
        res.writeHead(400);
        res.end('Invalid JSON');
      }
    });
    return;
  }

  // The Beckn action webhook -- discover / select / init / confirm,
  // same shape as course-bpp-server.js's /api/webhook/<action>.
  const webhookMatch = path.match(/^\/api\/webhook\/([a-zA-Z_]+)$/);
  if (req.method === 'POST' && webhookMatch) {
    const action = webhookMatch[1];
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let incoming;
      try {
        incoming = JSON.parse(body);
      } catch (e) {
        res.writeHead(400);
        res.end('Invalid JSON');
        return;
      }
      log.message('in', incoming, { from: 'onix-bpp' });
      handleAction(action, incoming);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: { ack: { status: 'ACK' } } }));
    });
    return;
  }

  // Provider approves a pending select (reserve) or confirm (fulfil) request.
  const approveMatch = path.match(/^\/api\/pending\/([a-zA-Z0-9-]+)\/approve$/);
  if (req.method === 'POST' && approveMatch) {
    resolvePending(approveMatch[1], true);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'approved' }));
    return;
  }

  // Provider rejects -- need goes back to 'open' so someone else can help.
  const rejectMatch = path.match(/^\/api\/pending\/([a-zA-Z0-9-]+)\/reject$/);
  if (req.method === 'POST' && rejectMatch) {
    resolvePending(rejectMatch[1], false);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'rejected' }));
    return;
  }

  if (req.method === 'GET' && (path === '/' || path === '')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(DASHBOARD_PAGE);
    return;
  }

  res.writeHead(404);
  res.end();
});

function handleAction(action, incoming) {
  const context = incoming.context || {};
  const message = incoming.message || {};

  if (action === 'discover') {
    // Real schema requires message = { intent: {...} } only -- needType/
    // region travel encoded as JSON inside intent.textSearch instead of
    // as sibling properties (see frontdoor-bap-server.js's trigger()).
    let needType, region;
    let decoded = {};
    try {
      decoded = JSON.parse((message.intent && message.intent.textSearch) || '{}');
      needType = decoded.needType;
      region = decoded.region;
    } catch (e) {
      needType = undefined;
      region = undefined;
    }
    // A search from a practitioner (or any search once a partner backend is
    // configured) goes through the /v1 path: partner match lookup, per-search
    // record, "practitioner.matched" event.
    if (decoded.practitionerId || v1.delegated) {
      v1.handleDiscover(context, { ...decoded, needType, region }).catch((e) => log.error('discover.failed', { transactionId: context.transactionId, error: e.message, stack: e.stack }));
      return;
    }
    const matches = providersMatching(needType, region);
    const callback = {
      context: { ...context, action: 'on_discover', timestamp: new Date().toISOString() },
      message: {
        // Real Catalog schema, same shape course-bpp-server.js already
        // proved works. Resource/descriptor fields beyond id + name are
        // not confirmed schema-safe, so provider kind/description/region
        // -- our own domain's data, not part of the real spec -- are
        // JSON-encoded into descriptor.name and decoded back out on the
        // front door side, the same "smuggle it through a string field"
        // approach used for needType/region above.
        catalogs: [
          {
            id: 'catalog-backbone',
            descriptor: { name: 'Digital Backbone Provider Catalog' },
            provider: { id: 'backbone', descriptor: { name: 'Digital Backbone' } },
            resources: matches.map((p) => ({
              id: p.id,
              descriptor: { name: JSON.stringify({ name: p.name, kind: p.kind, description: p.description, region: p.region }) },
            })),
          },
        ],
      },
    };
    sendCallback(callback);
    return;
  }

  // select/init/confirm all carry a real "contract" object now (see
  // frontdoor-bap-server.js's buildContract) instead of flat
  // {needId, providerId} -- same additionalProperties:false constraint
  // as discover. needId lives at commitments[0].resources[0].id,
  // providerId at participants[0].id.
  function extractFromContract(msg) {
    const contract = msg.contract || {};
    const commitment = (contract.commitments || [])[0] || {};
    const resource = (commitment.resources || [])[0] || {};
    const participant = (contract.participants || [])[0] || {};
    return { needId: resource.id, providerId: participant.id };
  }

  if (action === 'select') {
    const { needId, providerId } = extractFromContract(message);
    v1.ensureNeed(needId); // /v1 needs are created on first sight
    const need = needs.get(needId);
    if (!need) {
      rejectNow(context, needId, providerId, 'on_init'); // unknown need: nothing to reserve
      return;
    }
    // Same request repeated on the same transaction: ignore, it is already queued.
    if (pendingRequests.some((p) => p.needId === needId && p.context && p.context.transactionId === context.transactionId)) return;
    // Server-side duplicate protection: a need that is already reserved or
    // fulfilled, or that another request is already waiting on, cannot be
    // taken again. (Approve/reject is the only thing that changes it.)
    if (need.status !== 'open' || pendingRequests.some((p) => p.needId === needId)) {
      rejectNow(context, needId, providerId, 'on_init');
      return;
    }
    pendingRequests.push({ id: id('pending'), action: 'select', context, message, needId, providerId });
    return;
  }

  if (action === 'init') {
    // init immediately follows select in this v1 (same simplification
    // your course-enrollment flow already uses). We just re-check the
    // pending queue rather than adding a second queue.
    const { needId, providerId } = extractFromContract(message);
    // Match on the transaction too: two searches racing for the same need must
    // not adopt each other's request.
    const pending = pendingRequests.find(
      (p) =>
        p.action === 'select' &&
        p.needId === needId &&
        p.providerId === providerId &&
        p.context &&
        p.context.transactionId === context.transactionId
    );
    if (pending) {
      pending.action = 'init'; // now awaiting provider decision via /approve or /reject
      // The reply (on_init) answers THIS message, so it must carry init's
      // context, not the select's.
      pending.context = context;
      v1.onQueued(pending);
    }
    return;
  }

  if (action === 'confirm') {
    const { needId, providerId } = extractFromContract(message);
    const need = needs.get(needId);
    // Only a need this provider has reserved can be completed.
    if (!need || need.status !== 'reserved' || need.providerId !== providerId) {
      rejectNow(context, needId, providerId, 'on_confirm');
      return;
    }
    if (pendingRequests.some((p) => p.action === 'confirm' && p.needId === needId)) return;
    const pending = { id: id('pending'), action: 'confirm', context, message, needId, providerId };
    pendingRequests.push(pending);
    v1.onQueued(pending);
    return;
  }
}

function buildContractResponse(needId, providerId, statusCode) {
  // Same real schema shape as frontdoor-bap-server.js's outbound
  // buildContract -- the callback direction needs to match it too.
  // Reusing demo-bap-server.js's proven-valid status vocabulary
  // (ACTIVE/COMPLETED/REJECTED) rather than inventing our own
  // (RESERVED/FULFILLED), since those specific values are the ones
  // already confirmed to pass the real schema's enum validation.
  return {
    id: 'contract-' + needId,
    participants: [{ id: providerId, descriptor: { name: providerId, code: 'provider' } }],
    commitments: [
      {
        id: 'commitment-' + needId,
        descriptor: { name: needId, code: needId },
        status: { code: statusCode },
        resources: [{ id: needId, descriptor: { name: needId }, quantity: { unitQuantity: 1, unitCode: 'NEED' } }],
        offer: { id: 'offer-' + needId, resourceIds: [needId] },
      },
    ],
  };
}

function resolvePending(pendingId, approved) {
  const idx = pendingRequests.findIndex((p) => p.id === pendingId);
  if (idx === -1) return;
  const pending = pendingRequests[idx];
  pendingRequests.splice(idx, 1);

  const need = needs.get(pending.needId);
  if (!need) return;

  const before = need.status;
  const logStatus = () => {
    need.transactionId = (pending.context && pending.context.transactionId) || need.transactionId || null;
    need.updatedAt = new Date().toISOString();
    log.info('need.status_changed', { transactionId: need.transactionId, needId: pending.needId, providerId: pending.providerId, stage: pending.action, approved, from: before, to: need.status });
    v1.onNeedStatus(need, before, pending);
  };
  if (pending.action === 'init') {
    // reserve or reject-and-reopen
    need.status = approved ? 'reserved' : 'open';
    need.providerId = approved ? pending.providerId : null;
    const callback = {
      context: { ...pending.context, action: 'on_init', timestamp: new Date().toISOString() },
      message: { contract: buildContractResponse(pending.needId, pending.providerId, approved ? 'ACTIVE' : 'REJECTED') },
    };
    logStatus();
    sendCallback(callback);
  } else if (pending.action === 'confirm') {
    need.status = approved ? 'fulfilled' : 'reserved'; // rejected completion stays reserved
    if (approved) need.note = pending.message.note || '';
    const callback = {
      context: { ...pending.context, action: 'on_confirm', timestamp: new Date().toISOString() },
      message: { contract: buildContractResponse(pending.needId, pending.providerId, approved ? 'COMPLETED' : 'REJECTED') },
    };
    logStatus();
    sendCallback(callback);
  }
}

// ---- minimal built-in dashboard for the provider (NGO/Thabo) side ----
const DASHBOARD_PAGE = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Digital Backbone -- Provider Console</title>
<style>
  :root {
    --amber:#b4650a; --amber-dim:#fdf1e0; --amber-line:#f2d9ad;
    --cyan:#1d4ed8; --cyan-dim:#eaf1fd; --cyan-line:#c6d9f7;
    --green:#157347; --green-dim:#e6f4ee; --green-line:#bfe2d1;
    --rust:#b8291f; --rust-dim:#fdecea; --rust-line:#f3c3bd;
    --ink:#171e27; --muted:#5c6773; --muted-soft:#98a2ad;
    --bg:#f4f5f7; --panel:#ffffff; --line:#e2e7eb;
  }
  * { box-sizing: border-box; }
  body { margin:0; background: var(--bg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); -webkit-font-smoothing: antialiased; }
  header { background: linear-gradient(135deg, var(--ink) 0%, #0a0f16 130%); color: white; padding: 18px 28px; display:flex; align-items:center; justify-content:space-between; }
  header .dot { display:inline-block; width:7px; height:7px; border-radius:50%; background: var(--cyan); margin-right:9px; animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
  header h1 { font-size: 16px; margin: 0; letter-spacing: -.01em; }
  header p { font-size: 11.5px; margin: 4px 0 0; color: rgba(255,255,255,0.65); }
  main { max-width: 960px; margin: 0 auto; padding: 22px 28px; display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  main .full { grid-column: 1 / -1; }
  @media (max-width: 760px) { main { grid-template-columns: 1fr; } }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; box-shadow: 0 1px 2px rgba(20,28,38,.05); }
  .card h2 { font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--muted-soft); margin: 0 0 12px; }
  .pending-card { background: var(--amber-dim); border: 1px solid var(--amber-line); border-radius: 10px; padding: 12px; margin-bottom: 10px; }
  .pending-card .kind-tag { font-size: 9.5px; font-weight: 700; text-transform: uppercase; color: var(--amber); background: white; border: 1px solid var(--amber-line); padding: 2px 8px; border-radius: 5px; }
  .pending-card p { font-size: 12px; margin: 8px 0 2px; color: var(--ink); }
  .pending-card .note { font-style: italic; color: var(--muted); }
  .btn-row { margin-top: 10px; display:flex; gap: 8px; }
  button.approve { background: var(--green); color: white; border:none; padding: 8px 16px; border-radius: 7px; font-size: 12px; font-weight: 700; cursor:pointer; }
  button.approve:hover { background: #0d5c38; }
  button.reject { background: white; color: var(--rust); border: 1.5px solid var(--rust-line); padding: 8px 16px; border-radius: 7px; font-size: 12px; font-weight: 700; cursor:pointer; }
  button.reject:hover { background: var(--rust-dim); }
  .naledi-card { border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin-bottom: 10px; }
  .naledi-card .name-row { display:flex; justify-content:space-between; align-items:center; }
  .naledi-card h3 { margin:0; font-size: 13px; }
  .naledi-card .region-tag { font-size: 9.5px; font-weight: 700; text-transform: uppercase; color: var(--cyan); background: var(--cyan-dim); padding: 2px 8px; border-radius: 5px; }
  .need-chip { display:inline-block; font-size: 11px; padding: 4px 9px; border-radius: 6px; background: #edeef0; color: var(--muted); margin: 6px 6px 0 0; }
  .need-chip.reserved { background: var(--amber-dim); color: var(--amber); }
  .need-chip.fulfilled { background: var(--green-dim); color: var(--green); }
  .provider-row { display:flex; justify-content:space-between; align-items:center; border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px; margin-bottom: 8px; }
  .provider-row h4 { margin:0 0 3px; font-size: 12.5px; }
  .provider-row p { margin:0; font-size: 11px; color: var(--muted); }
  .tag { font-size: 9.5px; font-weight: 700; padding: 2px 8px; border-radius: 5px; text-transform: uppercase; white-space:nowrap; }
  .tag.ngo { background: var(--cyan-dim); color: var(--cyan); }
  .tag.thabo { background: var(--amber-dim); color: var(--amber); }
  .empty { color: var(--muted-soft); font-size: 12px; font-style: italic; padding: 8px 0; }
</style>
</head>
<body>
  <header>
    <div><h1><span class="dot"></span>Digital Backbone -- Provider Console</h1><p>Real Beckn ONIX relay -- approve/reject requests coming through onix-bpp.</p></div>
  </header>
  <main>
    <div class="card full">
      <h2>Pending requests</h2>
      <div id="pending"></div>
    </div>
    <div class="card">
      <h2>Naledis &amp; needs</h2>
      <div id="naledis"></div>
    </div>
    <div class="card">
      <h2>Registered providers</h2>
      <div id="providers"></div>
    </div>
  </main>
<script>
async function refresh() {
  const res = await fetch('/api/state');
  const state = await res.json();

  document.getElementById('pending').innerHTML = state.pending.length === 0
    ? '<div class="empty">No pending requests.</div>'
    : state.pending.map(p => \`
      <div class="pending-card">
        <span class="kind-tag">\${p.action === 'init' ? 'Reservation request' : 'Completion request'}</span>
        <p>Need <b>\${p.needId}</b> &middot; Provider <b>\${p.providerId}</b></p>
        \${p.message && p.message.note ? '<p class="note">"' + p.message.note + '"</p>' : ''}
        <div class="btn-row">
          <button class="approve" onclick="approve('\${p.id}')">Approve</button>
          <button class="reject" onclick="reject('\${p.id}')">Reject</button>
        </div>
      </div>\`).join('');

  document.getElementById('naledis').innerHTML = state.naledis.map(n => \`
    <div class="naledi-card">
      <div class="name-row"><h3>\${n.name}</h3><span class="region-tag">\${n.region}</span></div>
      <div>\${n.needs.map(need => '<span class="need-chip ' + need.status + '">' + need.type + ' &middot; ' + need.status + '</span>').join('')}</div>
    </div>\`).join('');

  document.getElementById('providers').innerHTML = state.providers.map(p => \`
    <div class="provider-row">
      <div><h4>\${p.name}</h4><p>Covers: \${p.needTypesCovered.join(', ')}</p></div>
      <span class="tag \${p.kind === 'NGO' ? 'ngo' : 'thabo'}">\${p.kind}</span>
    </div>\`).join('');
}
async function approve(id) { await fetch('/api/pending/' + id + '/approve', { method: 'POST' }); refresh(); }
async function reject(id) { await fetch('/api/pending/' + id + '/reject', { method: 'POST' }); refresh(); }
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;

started
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      log.info('server.listening', { port: Number(PORT) });
      console.log(`backbone-bpp server running on port ${PORT}`);
    });
  })
  .catch((e) => {
    log.error('server.start_failed', { error: e.message, stack: e.stack });
    process.exit(1);
  });

// On stop: finish the last database write and log entries, then exit.
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info('server.stopping', { signal });
  server.close();
  try {
    v1.persist();
    await v1.flush();
    await log.flush();
    if (pool) await pool.end();
  } catch (e) {
    log.error('server.stop_failed', { error: e.message });
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
