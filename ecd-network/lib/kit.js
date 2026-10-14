// kit.js -- what every ECD node app shares: its settings, its adapter, the
// registry, a small HTTP server, a message log and a JSON data file.
// No dependencies: plain Node 18+ (global fetch).

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { addresses } = require('./addresses');

const ROOT = path.resolve(__dirname, '..');

// The webhook path secret lives next to the node's keys (.keys/<id>.webhook),
// made by tools/configure.js.
function webhookSecret(node) {
  const f = path.join(ROOT, '.keys', `${node.subscriberId}.webhook`);
  if (!fs.existsSync(f)) {
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, crypto.randomBytes(16).toString('hex') + '\n', { mode: 0o600 });
  }
  const s = fs.readFileSync(f, 'utf8').trim();
  if (!/^[a-f0-9]{32}$/.test(s)) throw new Error(`bad webhook secret in ${f}`);
  return s;
}

function loadNode() {
  const file = process.env.NODE_FILE;
  if (!file) throw new Error('NODE_FILE must point at config/nodes/<id>.json');
  const node = JSON.parse(fs.readFileSync(file, 'utf8'));
  const network = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/network.json'), 'utf8'));
  const secret = webhookSecret(node);
  return { node, network, secret, addr: addresses(node, network, undefined, secret), hookRoute: new RegExp(`^/beckn/hook-${secret}/([a-z_]+)$`) };
}

function log(service, level, msg, extra = {}) {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), level, service, msg, ...extra }) + '\n');
}

// ---------------------------------------------------------------- data file
// One JSON file per node under data/. Written atomically; small by design.
function store(id, initial) {
  const dir = path.join(ROOT, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { state = JSON.parse(JSON.stringify(initial)); }
  let timer = null;
  function save() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
      fs.renameSync(tmp, file);
    }, 20);
  }
  return { state, save };
}

// ---------------------------------------------------------------- HTTP helpers
function send(res, code, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': typeof body === 'string' && headers['Content-Type'] ? headers['Content-Type'] : 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(Object.assign(new Error('body must be JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function serveFile(res, dir, name) {
  const file = path.join(dir, path.basename(name));
  if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' });
  const text = fs.readFileSync(file, 'utf8');
  const type = TYPES[path.extname(file)] || 'text/plain; charset=utf-8';
  send(res, 200, text, { ...(type.startsWith('text/html') ? PAGE_HEADERS : {}), 'Content-Type': type });
}

// A tiny router: routes = [[method, /regex/, handler(req,res,match,url)]]
function serve(port, routes, service) {
  // Only answer to names this app is really reached by (blocks DNS rebinding).
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `${service.replace(/-app$/, '')}-app:${port}`,
    ...String(process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean)]);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!allowed.has(String(req.headers.host || ''))) return send(res, 421, { error: 'unknown host' });
    try {
      for (const [method, re, handler] of routes) {
        if (method !== req.method) continue;
        const m = url.pathname.match(re);
        if (m) return await handler(req, res, m, url);
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      const code = e.status || 500;
      if (code >= 500) log(service, 'error', 'request failed', { path: url.pathname, error: e.message });
      send(res, code, { error: code >= 500 ? 'internal error' : e.message });
    }
  });
  // Local runs listen on loopback only; in a container the host maps the port.
  const host = process.env.HOST || (process.env.ECD_MODE === 'docker' ? '0.0.0.0' : '127.0.0.1');
  server.listen(port, host, () => log(service, 'info', 'listening', { host, port }));
  return server;
}

// ---------------------------------------------------------------- Beckn
function context(network, action, fields) {
  return {
    networkId: network.networkId,
    action,
    version: network.version,
    bapId: fields.bapId,
    bapUri: fields.bapUri,
    ...(fields.bppId ? { bppId: fields.bppId, bppUri: fields.bppUri } : {}),
    transactionId: fields.transactionId,
    messageId: fields.messageId || crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ttl: 'PT30S',
  };
}

// Hands a message to this node's own ONIX adapter. The adapter routes it,
// signs it, sends it and returns the receiver's (signed) ACK or NACK.
async function callAdapter(addr, action, body) {
  const url = `${addr.caller}/${action}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    // ONIX answers ACK as {message:{ack:{status}}} and NACK as {message:{status:'NACK', error:{code,message}}}.
    const msg = (json && json.message) || {};
    const ack = (msg.ack && msg.ack.status) || msg.status || null;
    const err = msg.error || (json && json.error) || null;
    return { ok: r.ok && ack === 'ACK', status: r.status, ack, error: err ? (err.code ? `${err.code}: ${err.message || ''}` : String(err.message || err)) : (r.ok ? null : text.slice(0, 300)) };
  } catch (e) {
    return { ok: false, status: 0, ack: null, error: e.message };
  }
}

async function registryMembers(addr, type) {
  const r = await fetch(`${addr.registry}/subscribers${type ? `?type=${type}` : ''}`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`registry answered ${r.status}`);
  return (await r.json()).subscribers;
}

// Every Beckn message in and out, newest last, capped. Kept in the data file.
function messageLog(db, max = 500) {
  db.state.messages = db.state.messages || [];
  return {
    add(entry) {
      db.state.messages.push({ at: new Date().toISOString(), ...entry });
      if (db.state.messages.length > max) db.state.messages.splice(0, db.state.messages.length - max);
      db.save();
    },
    // Message bodies can hold a practitioner's shared details, so the API
    // returns them only when ECD_DEBUG_BODIES=1 (tests); otherwise metadata only.
    list(filter = {}) {
      const withBodies = process.env.ECD_DEBUG_BODIES === '1';
      return db.state.messages.filter((m) => !filter.transactionId || m.transactionId === filter.transactionId).slice().reverse()
        .map((m) => (withBodies ? m : (({ body, ...rest }) => rest)(m)));
    },
  };
}

// The adapter forwards checked messages to POST /beckn/hook-<secret>/<action>.
// We ACK at once and work afterwards; a repeated messageId is ACKed and dropped.
function webhookHandler({ db, msgs, service, handlers }) {
  db.state.seen = db.state.seen || [];
  return async (req, res, m) => {
    const action = m[1];
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'JSON only' });
    const body = await readJson(req);
    const ctx = body.context || {};
    const key = `${action}:${ctx.messageId}`;
    send(res, 200, { message: { ack: { status: 'ACK' } } });
    if (!ctx.messageId || db.state.seen.includes(key)) {
      log(service, 'info', 'duplicate or unidentified message dropped', { action, messageId: ctx.messageId });
      return;
    }
    db.state.seen.push(key);
    if (db.state.seen.length > 2000) db.state.seen.splice(0, 500);
    msgs.add({ direction: 'in', action, transactionId: ctx.transactionId, messageId: ctx.messageId, from: action.startsWith('on_') ? ctx.bppId : ctx.bapId, ack: 'ACK', body });
    const h = handlers[action];
    if (!h) return log(service, 'info', 'no handler for action', { action });
    try { await h(body); } catch (e) { log(service, 'error', 'handler failed', { action, error: e.message }); }
  };
}

module.exports = { webhookSecret, loadNode, log, store, send, readJson, serve, serveFile, context, callAdapter, registryMembers, messageLog, webhookHandler, PAGE_HEADERS };
