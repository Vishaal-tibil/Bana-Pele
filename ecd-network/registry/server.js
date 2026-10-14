// ecd-registry: the private registry of the Bana Pele ECD Network.
//
// Every node (Journey, WeHelp, Grow, ...) has one record here: its subscriber
// id, Beckn role, receiver url and public keys. Two kinds of callers:
//
//   ONIX adapters  POST /lookup        {subscriber_id, key_id}  -> [record]
//                  (the request and response shape of ONIX's "registry"
//                  plugin, pkg/plugin/implementation/registry/registry.go:
//                  the body is a model.Subscription, the answer a list of them)
//   our apps       GET  /subscribers?type=BPP   -> live members, for discover
//                  GET  /health
//
// Records live in registry.json (path in REGISTRY_FILE). The file is re-read
// whenever it changes, so adding or pausing a node needs no restart.
// No dependencies: plain Node 18+.

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3030);
const FILE = process.env.REGISTRY_FILE || path.join(__dirname, 'registry.json');
// Statuses ONIX treats as usable (model.IsKeyStatusUsable rejects EXPIRED,
// UNSUBSCRIBED, INVALID_SSL). We use SUBSCRIBED for live and UNSUBSCRIBED for
// a paused node, so the adapters refuse a paused node's messages.
const LIVE = 'SUBSCRIBED';

let cache = { mtimeMs: -1, data: { networkId: '', subscribers: [] } };

function load() {
  let st;
  try { st = fs.statSync(FILE); } catch { return cache.data; }
  if (st.mtimeMs !== cache.mtimeMs) {
    try {
      const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (!Array.isArray(data.subscribers)) throw new Error('subscribers must be a list');
      cache = { mtimeMs: st.mtimeMs, data };
      log('info', 'registry loaded', { file: FILE, subscribers: data.subscribers.length });
    } catch (e) {
      // Keep serving the last good copy rather than an empty registry.
      log('error', 'registry file unreadable, keeping last good copy', { error: e.message });
    }
  }
  return cache.data;
}

function log(level, msg, extra = {}) {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), level, service: 'ecd-registry', msg, ...extra }) + '\n');
}

// The fields ONIX reads from a model.Subscription.
function toSubscription(r) {
  return {
    subscriber_id: r.subscriber_id,
    url: r.url,
    type: r.type,
    domain: r.domain || '',
    key_id: r.key_id,
    signing_public_key: r.signing_public_key,
    encr_public_key: r.encr_public_key,
    // No valid_until on purpose: ONIX caches a lookup until valid_until when it
    // is set, which would make a paused node's key usable for years. Without
    // it the adapter's own cacheTTL applies (registryCacheTTL in network.json).
    status: r.status || LIVE,
    created: r.created || '2026-01-01T00:00:00Z',
    updated: r.updated || '2026-01-01T00:00:00Z',
  };
}

function send(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 64 * 1024) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'POST' && url.pathname === '/lookup') {
      let q;
      try { q = JSON.parse(await readBody(req) || '{}'); } catch { return send(res, 400, { error: 'body must be JSON' }); }
      const { subscribers } = load();
      const hits = subscribers.filter((r) =>
        (!q.subscriber_id || r.subscriber_id === q.subscriber_id) &&
        (!q.key_id || r.key_id === q.key_id) &&
        (!q.type || r.type === q.type) &&
        (!q.domain || !r.domain || r.domain === q.domain));
      log('info', 'lookup', { subscriber_id: q.subscriber_id, key_id: q.key_id, found: hits.length });
      return send(res, 200, hits.map(toSubscription));
    }
    if (req.method === 'GET' && url.pathname === '/subscribers') {
      const { networkId, subscribers } = load();
      const type = url.searchParams.get('type');
      const all = url.searchParams.get('all') === '1';
      const list = subscribers
        .filter((r) => (!type || r.type === type) && (all || (r.status || LIVE) === LIVE))
        .map((r) => ({ ...toSubscription(r), name: r.name || r.subscriber_id }));
      return send(res, 200, { networkId, subscribers: list });
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      const { networkId, subscribers } = load();
      return send(res, 200, { ok: true, service: 'ecd-registry', networkId, subscribers: subscribers.length });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    log('error', 'request failed', { error: e.message });
    send(res, 500, { error: 'internal error' });
  }
});

// Loopback unless told otherwise (in Docker, compose sets HOST=0.0.0.0).
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => { load(); log('info', 'listening', { host: HOST, port: PORT }); });
