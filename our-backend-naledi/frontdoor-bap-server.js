// frontdoor-bap-server.js
//
// Naledi's "front door" -- the BAP side. Mirrors demo-bap-server.js's
// pattern exactly: fires Beckn discover/select/init/confirm requests
// out, and receives async on_* callbacks back at /api/bap-webhook/<action>.
//
// v1 scope: one hardcoded demo Naledi (naledi-001, matching the seed
// data in backbone-bpp-server.js). Multi-Naledi support, real auth,
// and free-text need description are NOT yet built -- same honest
// scoping as the rest of this project.

const http = require('http');
const crypto = require('crypto');
const { createLogger } = require('./logger');
const { openPool } = require('./db');

const log = createLogger(process.env.SERVICE_NAME || 'sandbox-bap');
const pool = openPool(log);
log.attachDb(pool);

const PORT = process.env.PORT || 4000;
const BACKBONE_CALLER = process.env.BACKBONE_CALLER || 'http://localhost:4001/api/webhook';
const BACKBONE_BASE_URL = process.env.BACKBONE_BASE_URL || 'http://localhost:4001';

const DEMO_NALEDI_ID = 'naledi-001';
let transactionId = crypto.randomUUID();
let lastDiscoverResult = null; // { providers }
// Last few messages, for the built-in demo page only (the persistent log is
// the structured one, see logger.js).
let pageLog = [];

function addLog(direction, action, payload) {
  pageLog.unshift({ time: new Date().toLocaleTimeString(), direction, action, payload });
  pageLog = pageLog.slice(0, 30);
}

// Identity is configuration, not code: the values below default to the
// starter kit's shared sandbox identities and can be overridden per
// environment (BAP_ID, BPP_ID, NETWORK_ID, BAP_URI, BPP_URI).
const NETWORK_ID = process.env.NETWORK_ID || 'beckn.one/testnet';
const BAP_ID = process.env.BAP_ID || 'bap.example.com';
const BPP_ID = process.env.BPP_ID || 'bpp.example.com';
// bapUri / bppUri are always sent explicitly: they are the addresses the two
// adapters use to reach each other inside the Docker network.
const BAP_URI = process.env.BAP_URI || 'http://onix-bap:8081/bap/receiver';
const BPP_URI = process.env.BPP_URI || 'http://onix-bpp:8082/bpp/receiver';

// txId defaults to the legacy single transaction so the built-in page keeps
// working; the /v1 API passes its own per-request transaction id.
function buildContext(action, txId = transactionId, ttl = 'PT30S') {
  return {
    networkId: NETWORK_ID,
    action,
    version: '2.0.0',
    // Must match the actual subscriber identities onix-bap/onix-bpp are
    // configured with (see their startup logs: "subscriberID: bap.example.com"
    // / "bpp.example.com") -- these containers are single-tenant, configured
    // with one specific identity + signing key each, not a per-application
    // one. A different bapId/bppId here is very likely why discover requests
    // were being accepted but never completing the round trip.
    bapId: BAP_ID,
    bapUri: BAP_URI,
    bppId: BPP_ID,
    bppUri: BPP_URI,
    transactionId: txId,
    messageId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ttl: ttl || 'PT30S',
  };
}

// Sends one Beckn action through onix-bap. Resolves to
// { ok, status, text } (or { ok:false, error }) so callers can tell when the
// adapter rejected the message -- a schema or signing failure comes back as
// an HTTP error or a NACK body, not as a network exception.
function trigger(action, message, txId, opts = {}) {
  const context = buildContext(action, txId, opts.ttl);
  // Real schema requires message = { intent: {...} } only for discover
  // (additionalProperties: false, confirmed directly from onix-bap's
  // rejection: 'property "needType" is unsupported'). needType/region
  // ride encoded as JSON inside intent.textSearch instead.
  //
  // select/init/confirm have the SAME constraint -- confirmed again by
  // onix-bap rejecting our {needId, providerId} shape with 'property
  // "needId" is unsupported'. The real, working shape (proven by
  // demo-bap-server.js/course-bpp-server.js already running through
  // this same relay) is a "contract" object. needId/providerId are
  // carried as commitments[0].resources[0].id / participants[0].id
  // respectively, reusing that exact structure for our domain.
  function buildContract(needId, providerId, statusCode) {
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
  const STATUS_FOR_ACTION = { select: 'DRAFT', init: 'ACTIVE', confirm: 'COMPLETED', cancel: 'CANCELLED' };
  let outgoingMessage;
  if (action === 'discover') {
    // practitionerId / tier / children are undefined for the built-in page and
    // simply left out by JSON.stringify.
    outgoingMessage = {
      intent: {
        textSearch: JSON.stringify({
          needType: message.needType,
          region: message.region,
          practitionerId: message.practitionerId,
          tier: message.tier,
          children: message.children,
          title: message.title,
          description: message.description,
        }),
      },
    };
  } else if (STATUS_FOR_ACTION[action]) {
    outgoingMessage = { contract: buildContract(message.needId, message.providerId, STATUS_FOR_ACTION[action]) };
  } else {
    outgoingMessage = message;
  }
  const payload = { context, message: outgoingMessage };
  addLog('sent', action, payload);
  log.message('out', payload, { to: 'onix-bap' });
  const url = `${BACKBONE_CALLER}/${action}`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then(async (res) => {
      // Previously only network-level failures were caught here -- a
      // real HTTP error response from onix-bap (schema rejection,
      // signing failure, etc.) would silently look like "it worked"
      // since fetch() doesn't reject on non-2xx statuses.
      const text = await res.text().catch(() => '');
      const ok = res.ok && !text.includes('"NACK"');
      log[ok ? 'info' : 'warn']('beckn.ack', { transactionId: context.transactionId, messageId: context.messageId, action, from: 'onix-bap', httpStatus: res.status, ack: ok ? 'ACK' : 'NACK', body: text.slice(0, 2000) });
      return { ok, status: res.status, text };
    })
    .catch((err) => {
      log.error('beckn.send_failed', { transactionId: context.transactionId, messageId: context.messageId, action, to: 'onix-bap', error: err.message, cause: err.cause && String(err.cause) });
      return { ok: false, status: 0, error: err.message };
    });
}

// The /v1 REST layer for My Journey's backend (see v1-bap.js).
const v1 = require('./v1-bap')({ trigger, log, pool });

function handleCallback(action, incoming) {
  addLog('received', action, incoming);
  log.message('in', incoming, { from: 'onix-bap' });
  // Callbacks that belong to a /v1 transaction are handled there; anything
  // else is the built-in page's single legacy transaction (below).
  if (v1.onCallback(action, incoming)) return;
  const message = incoming.message || {};
  if (action === 'on_discover') {
    // Real response shape is { catalogs: [{ resources: [...] }] }, not a
    // flat { providers } we invented earlier -- decode resources back
    // into the flat provider list the demo page expects, reversing the
    // JSON-in-descriptor.name encoding used on the backbone side.
    const resources = ((message.catalogs || [])[0] || {}).resources || [];
    const providers = resources.map((r) => {
      let decoded = {};
      try {
        decoded = JSON.parse(r.descriptor.name);
      } catch (e) {
        decoded = { name: r.descriptor && r.descriptor.name };
      }
      return { id: r.id, ...decoded };
    });
    lastDiscoverResult = { providers };
  }
  // on_init / on_confirm just get logged -- the demo page polls /api/state
  // on the backbone directly for the Naledi's actual need statuses,
  // same pattern as your existing citizen_app polling /api/state.
}

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

  if (req.method === 'GET' && path === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // REST API for My Journey's backend.
  if (v1.handle(req, res, path)) return;

  // Trigger a Beckn action from the front door.
  // POST body shapes:
  //   discover: { needType, region }
  //   select:   { needId, providerId }
  //   init:     { needId, providerId }
  //   confirm:  { needId, providerId, note }
  const triggerMatch = path.match(/^\/api\/trigger\/([a-zA-Z_]+)$/);
  if (req.method === 'POST' && triggerMatch) {
    const action = triggerMatch[1];
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let message = {};
      try {
        message = body ? JSON.parse(body) : {};
      } catch (e) {
        res.writeHead(400);
        res.end('Invalid JSON');
        return;
      }
      await trigger(action, message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'triggered' }));
    });
    return;
  }

  // Receives on_discover / on_select / on_init / on_confirm callbacks.
  const webhookMatch = path.match(/^\/api\/bap-webhook\/(on_[a-zA-Z_]+)$/);
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
      handleCallback(action, incoming);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: { ack: { status: 'ACK' } } }));
    });
    return;
  }

  // Combined state for the demo page: Naledi's real needs (fetched live
  // from the backbone) plus the last discover result and the log.
  if (req.method === 'GET' && path === '/api/state') {
    fetch(`${BACKBONE_BASE_URL}/api/state`)
      .then((r) => r.json())
      .then((backboneState) => {
        const naledi = backboneState.naledis.find((n) => n.id === DEMO_NALEDI_ID);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ naledi, lastDiscoverResult, log: pageLog }));
      })
      .catch((err) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ naledi: null, lastDiscoverResult, log: pageLog, error: err.message }));
      });
    return;
  }

  // Split-screen view: this app + the provider app side by side in
  // iframes, same pattern as the reference frontend's own /live page.
  if (req.method === 'GET' && path === '/live') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(LIVE_PAGE);
    return;
  }

  if (req.method === 'GET' && (path === '/' || path === '')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(FRONTDOOR_PAGE);
    return;
  }

  res.writeHead(404);
  res.end();
});

const LIVE_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Naledi Backbone -- Live Split View</title>
<style>
  :root {
    --ink:#171e27; --muted:#5c6773; --bg:#eef1f4; --line:#e2e7eb;
    --amber:#b4650a; --cyan:#1d4ed8; --ease: cubic-bezier(.22,.9,.35,1);
  }
  * { box-sizing: border-box; }
  html, body { margin:0; height:100%; background: var(--bg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); -webkit-font-smoothing: antialiased; }
  body { display:flex; flex-direction:column; }

  header { background: linear-gradient(135deg, var(--ink) 0%, #0a0f16 130%); color: white; padding: 12px 20px; display:flex; align-items:center; justify-content:space-between; flex-wrap: wrap; gap: 8px; }
  header .brand { font-weight: 700; font-size: 14.5px; letter-spacing: -.01em; }
  header .brand small { display:block; font-weight: 400; font-size: 11.5px; color: rgba(255,255,255,0.6); margin-top: 3px; }
  header button { background: none; border: 1px solid rgba(255,255,255,0.3); color: white; font-size: 11px; padding: 5px 11px; border-radius: 6px; cursor: pointer; transition: all .15s var(--ease); }
  header button:hover { background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.5); }

  .split { flex: 1; display: flex; min-height: 0; }
  .pane { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .pane + .pane { border-left: 3px solid var(--ink); }
  .pane-label { padding: 9px 16px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); background: white; border-bottom: 1px solid var(--line); display:flex; align-items:center; gap: 8px; }
  .pane-label .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--amber); animation: pulse-dot 2.2s ease-in-out infinite; }
  @keyframes pulse-dot { 0%, 100% { box-shadow: 0 0 0 0 rgba(180,101,10,.35); } 50% { box-shadow: 0 0 0 4px rgba(180,101,10,0); } }
  .pane-label.provider .dot { background: var(--cyan); animation-name: pulse-dot-cyan; }
  @keyframes pulse-dot-cyan { 0%, 100% { box-shadow: 0 0 0 0 rgba(29,78,216,.35); } 50% { box-shadow: 0 0 0 4px rgba(29,78,216,0); } }
  .pane iframe { flex: 1; border: none; width: 100%; height: 100%; background: white; }

  /* Naledi's pane gets an actual phone-shaped frame, not a full-width
     iframe -- this is the "mobile view" for the learner-facing app.
     The provider pane stays a normal flowing web page. */
  .pane.mobile { background: #2b2b2e; align-items: center; justify-content: center; padding: 20px; }
  .pane.mobile .phone {
    width: 390px; max-width: 100%; height: 100%; max-height: 780px;
    border-radius: 32px; overflow: hidden; box-shadow: 0 20px 45px -12px rgba(0,0,0,.5);
    display: flex; flex-direction: column; background: white;
  }
  .pane.mobile .phone iframe { flex: 1; border: none; width: 100%; }

  @media (max-width: 800px) {
    .split { flex-direction: column; }
    .pane + .pane { border-left: none; border-top: 3px solid var(--ink); }
  }
</style>
</head>
<body>
<header>
  <div class="brand">Naledi Backbone -- Live <small>Real Beckn ONIX relay underneath -- nothing here is faked or synced client-side</small></div>
  <button id="reload-both">Reset both</button>
</header>
<div class="split">
  <div class="pane mobile">
    <div class="pane-label" style="background:transparent; border:none; color:white; justify-content:center; margin-bottom:10px;"><span class="dot"></span> Naledi -- requests support</div>
    <div class="phone">
      <iframe id="frame-naledi" src="http://localhost:3001"></iframe>
    </div>
  </div>
  <div class="pane">
    <div class="pane-label provider"><span class="dot"></span> Provider -- accepts / declines / fulfils</div>
    <iframe id="frame-provider" src="http://localhost:3002"></iframe>
  </div>
</div>
<script>
document.getElementById("reload-both").onclick = () => {
  document.getElementById("frame-naledi").src = document.getElementById("frame-naledi").src;
  document.getElementById("frame-provider").src = document.getElementById("frame-provider").src;
};
</script>
</body>
</html>
`;

const FRONTDOOR_PAGE = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Naledi's Front Door</title>
<style>
  :root {
    --amber:#b4650a; --amber-dim:#fdf1e0; --amber-line:#f2d9ad;
    --cyan:#1d4ed8; --cyan-dim:#eaf1fd; --cyan-line:#c6d9f7;
    --green:#157347; --green-dim:#e6f4ee; --green-line:#bfe2d1;
    --ink:#171e27; --muted:#5c6773; --muted-soft:#98a2ad;
    --bg:#f4f5f7; --panel:#ffffff; --line:#e2e7eb;
  }
  * { box-sizing: border-box; }
  body { margin:0; background: var(--bg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); -webkit-font-smoothing: antialiased; }
  header { background: linear-gradient(135deg, var(--amber) 0%, #8a4a06 130%); color: white; padding: 16px 18px; }
  header .dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:#fff; margin-right:8px; animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
  header h1 { font-size: 15.5px; margin: 0; letter-spacing: -.01em; }
  header p { font-size: 11.5px; margin: 4px 0 0; opacity: .85; line-height:1.5; }
  main { padding: 14px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px; margin-bottom: 12px; box-shadow: 0 1px 2px rgba(20,28,38,.05); }
  .card h2 { font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--muted-soft); margin: 0 0 10px; }
  .chip { display:inline-flex; align-items:center; gap:6px; padding: 6px 10px; border-radius: 8px; background: #edeef0; font-size: 11.5px; margin: 0 6px 6px 0; }
  .chip.reserved { background: var(--amber-dim); color: var(--amber); }
  .chip.fulfilled { background: var(--green-dim); color: var(--green); }
  .chip.waiting { background: var(--cyan-dim); color: var(--cyan); }
  select, input { width: 100%; padding: 10px; border: 1.5px solid var(--line); border-radius: 8px; font-size: 13.5px; font-family: inherit; background: var(--bg); color: var(--ink); margin-bottom: 8px; }
  select:focus, input:focus { outline:none; border-color: var(--amber); }
  button.primary { width:100%; background: var(--amber); color: white; border:none; padding: 12px; border-radius: 8px; font-size: 13.5px; font-weight: 700; cursor:pointer; }
  button.primary:hover { background: #8a4a06; }
  .provider-card { border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin-top: 10px; }
  .provider-card .row { display:flex; justify-content:space-between; align-items:flex-start; gap:8px; }
  .provider-card h3 { margin:0; font-size: 13.5px; }
  .tag { font-size: 9.5px; font-weight: 700; padding: 2px 7px; border-radius: 4px; text-transform: uppercase; letter-spacing: .03em; white-space: nowrap; }
  .tag.ngo { background: var(--cyan-dim); color: var(--cyan); }
  .tag.thabo { background: var(--amber-dim); color: var(--amber); }
  .provider-card p.desc { font-size: 11.5px; color: var(--muted); margin: 6px 0; line-height: 1.5; }
  .provider-card .already { font-size: 11px; font-style: italic; color: var(--muted-soft); }
  button.select-btn { border: 1.5px solid var(--line); background: white; color: var(--amber); padding: 6px 12px; border-radius: 7px; font-size: 11.5px; font-weight: 700; cursor:pointer; float:right; }
  button.select-btn:hover { background: var(--amber-dim); }
  .empty { color: var(--muted-soft); font-size: 12px; font-style: italic; padding: 6px 0; }
  details.techlog { margin-top: 4px; }
  details.techlog summary { font-size: 10.5px; color: var(--muted-soft); cursor:pointer; }
  pre { background: #171e27; color: #8FD19E; padding: 8px; border-radius: 8px; font-size: 9.5px; overflow-x:auto; margin: 6px 0; }

</style>
</head>
<body>
  <header>
    <h1><span class="dot"></span>Naledi's Front Door</h1>
  </header>
  <div id="statusBanner" style="display:none; background:var(--ink); color:white; padding:10px 14px; font-size:12.5px; font-weight:600; text-align:center;"></div>
  <main>
    <div class="card">
      <h2>My needs</h2>
      <div id="needs"></div>
    </div>

    <div class="card">
      <h2>Tell us what's going on</h2>
      <textarea id="freeText" rows="3" placeholder="e.g. &quot;I want to register my ELP but I don't understand what the municipality needs&quot;" style="width:100%; padding:10px; border:1.5px solid var(--line); border-radius:8px; font-size:13.5px; font-family:inherit; background:var(--bg); color:var(--ink); margin-bottom:8px; resize:vertical;"></textarea>
      <input id="region" value="Gauteng" placeholder="Region" />
      <button class="primary" onclick="findFromFreeText()">Find help</button>
      <div id="matchNote" style="font-size:11px; color:var(--muted); margin-top:8px;"></div>

      <details style="margin-top:12px;">
        <summary style="font-size:11px; color:var(--muted-soft); cursor:pointer;">Or pick a category directly</summary>
        <select id="needType" style="margin-top:8px;">
          <option value="starter-kit">Starter-kit</option>
          <option value="registration">Registration</option>
          <option value="capability-development">Capability development</option>
          <option value="fundraising">Fundraising</option>
          <option value="infrastructure">Infrastructure</option>
          <option value="peer-guidance">Peer guidance</option>
        </select>
        <button class="primary" style="margin-top:8px;" onclick="discover()">Discover</button>
      </details>
      <div id="discoverResults"></div>
    </div>

    <div class="card">
      <details class="techlog">
        <summary>Technical log (real Beckn traffic)</summary>
        <div id="log"></div>
      </details>
    </div>
  </main>
<script>
// Tracks needs we're actively waiting on a decision for (set right when
// Select is clicked), and the last status we saw for each need -- so we
// can notice the moment a need's status actually changes and show a
// clear, human notice, instead of silently updating a small chip that's
// easy to miss.
const pendingNeedIds = new Set();
const lastKnownStatus = {};

async function refresh() {
  const res = await fetch('/api/state');
  const state = await res.json();
  const needs = state.naledi ? state.naledi.needs : [];

  needs.forEach((n) => {
    const prev = lastKnownStatus[n.id];
    if (prev !== undefined && prev !== n.status && pendingNeedIds.has(n.id)) {
      // A need we were waiting on just changed -- tell the user plainly.
      showBanner(
        n.status === 'reserved'
          ? '✅ ' + (n.providerId || 'A provider') + ' approved your ' + n.type + ' request!'
          : n.status === 'open'
          ? '❌ Your ' + n.type + ' request was declined -- you can try a different provider.'
          : '✅ Your ' + n.type + ' request was marked complete!'
      );
      pendingNeedIds.delete(n.id);
    }
    lastKnownStatus[n.id] = n.status;
  });

  document.getElementById('needs').innerHTML = needs.length ? needs.map(n => {
    const waiting = pendingNeedIds.has(n.id);
    const label = waiting ? 'awaiting response...' : n.status;
    const cls = waiting ? 'waiting' : n.status;
    return '<span class="chip ' + cls + '">' + n.type + ' &middot; ' + (waiting ? '⏳ ' : '') + label + '</span>';
  }).join('') : '<div class="empty">No needs on record.</div>';

  document.getElementById('log').innerHTML = state.log.slice(0, 6).map(e =>
    '<pre>' + e.time + ' ' + e.direction.toUpperCase() + ' ' + e.action + '</pre>'
  ).join('');
  return { needs };
}

function showBanner(text) {
  const el = document.getElementById('statusBanner');
  el.textContent = text;
  el.style.display = 'block';
  clearTimeout(showBanner._t);
  showBanner._t = setTimeout(() => { el.style.display = 'none'; }, 8000);
}

// Simple keyword matching -- stands in for the real thing (an LLM
// reading free text and understanding intent, discussed but not built
// tonight). Naledi never sees "need types" here; she just describes
// her problem, and this guesses the closest category. Not smart, but
// genuinely functional, and honest about being a placeholder for a
// real NLU/LLM step later.
const NEED_KEYWORDS = {
  'registration': ['register', 'registration', 'municipality', 'municipal', 'compliance', 'licence', 'license', 'permit', 'legal', 'paperwork'],
  'capability-development': ['teaching', 'curriculum', 'quality', 'training', 'skills', 'practitioner', 'lesson', 'pedagogy', 'classroom'],
  'fundraising': ['fund', 'funding', 'money', 'financial', 'sustainability', 'business', 'paying', 'payment', 'income', 'grant', 'afford'],
  'starter-kit': ['starter', 'kit', 'materials', 'toys', 'equipment', 'supplies', 'setting up', 'set up'],
  'infrastructure': ['facility', 'facilities', 'building', 'safety', 'health', 'space', 'room', 'toilet', 'water', 'electricity'],
  'peer-guidance': ['peer', 'other naledi', 'someone who has done this', 'experience', 'advice', 'guidance', 'mentor', 'talk to someone'],
};

function matchNeedType(text) {
  const lower = text.toLowerCase();
  let best = null, bestScore = 0;
  for (const [needType, keywords] of Object.entries(NEED_KEYWORDS)) {
    const score = keywords.filter(k => lower.includes(k)).length;
    if (score > bestScore) { bestScore = score; best = needType; }
  }
  return { needType: best, matched: bestScore > 0 };
}

async function findFromFreeText() {
  const text = document.getElementById('freeText').value.trim();
  const noteEl = document.getElementById('matchNote');
  if (!text) { noteEl.textContent = 'Please describe what you need help with first.'; return; }
  const { needType, matched } = matchNeedType(text);
  if (!matched) {
    noteEl.textContent = "Couldn't quite tell what kind of help this needs -- try the category list below instead.";
    return;
  }
  noteEl.textContent = 'Based on what you said, this sounds like: "' + needType + '". Searching...';
  document.getElementById('needType').value = needType;
  await discover();
  noteEl.textContent = 'Matched to: "' + needType + '" (simple keyword match -- not a real AI understanding yet).';
}

async function discover() {
  const needType = document.getElementById('needType').value;
  const region = document.getElementById('region').value;
  document.getElementById('discoverResults').innerHTML = '<div class="empty">Searching the real network...</div>';
  await fetch('/api/trigger/discover', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ needType, region })
  });
  setTimeout(async () => {
    const { needs } = await refresh();
    const res = await fetch('/api/state');
    const state = await res.json();
    const results = state.lastDiscoverResult;
    if (!results || !results.providers.length) { document.getElementById('discoverResults').innerHTML = '<div class="empty">No matching providers.</div>'; return; }
    const need = needs.find(n => n.type === needType);
    const alreadyHandled = need && need.status !== 'open';
    document.getElementById('discoverResults').innerHTML = results.providers.map(p => {
      const tagClass = p.kind === 'NGO' ? 'ngo' : 'thabo';
      return '<div class="provider-card">' +
        '<div class="row"><h3>' + p.name + '</h3><span class="tag ' + tagClass + '">' + p.kind + '</span></div>' +
        '<p class="desc">' + p.description + '</p>' +
        (!need
          ? '<span class="already">No need on record for this category.</span>'
          : alreadyHandled
          ? '<span class="already">Already ' + need.status + (need.providerId ? ' by ' + need.providerId : '') + '.</span>'
          : '<button class="select-btn" onclick="selectProvider(\\'' + need.id + '\\', \\'' + p.id + '\\')">Select</button>') +
        '</div>';
    }).join('');
  }, 900);
}

async function selectProvider(needId, providerId) {
  pendingNeedIds.add(needId);
  refresh(); // show "⏳ awaiting response..." immediately, don't wait for the next poll
  await fetch('/api/trigger/select', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ needId, providerId }) });
  await fetch('/api/trigger/init', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ needId, providerId }) });
  showBanner('Request sent -- waiting for the provider to respond...');
  setTimeout(refresh, 500);
}

refresh();
setInterval(refresh, 2500);
</script>
</body>
</html>`;
// Start listening only once the saved state is loaded.
v1.ready
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      log.info('server.listening', { port: Number(PORT) });
      console.log(`frontdoor-bap server running on port ${PORT}`);
    });
  })
  .catch((e) => {
    log.error('server.start_failed', { error: e.message, stack: e.stack });
    process.exit(1);
  });

// On stop (docker stop / restart, a new revision on Azure): finish the last
// database write and log entries, then exit.
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info('server.stopping', { signal });
  server.close();
  try {
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
