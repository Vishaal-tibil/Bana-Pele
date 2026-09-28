// netlib.js
//
// Tiny, zero-dependency helpers shared by the two Naledi translators
// (frontdoor-bap-server.js = buyer side, backbone-bpp-server.js = provider
// side):
//   - createStore   : a JSON state file, written atomically on every save
//   - createOutbox  : events pushed to the partner's webhook, with retry and
//                     an order-preserving queue that survives a restart
//   - small HTTP helpers (json body, key check, fetch with timeout)

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

// ---- state file ----

function createStore(file, initial) {
  const state = JSON.parse(JSON.stringify(initial));
  if (file) {
    try {
      if (fs.existsSync(file)) {
        Object.assign(state, JSON.parse(fs.readFileSync(file, 'utf8')));
        console.log(`[store] loaded ${file}`);
      }
    } catch (e) {
      console.error(`[store] could not read ${file}: ${e.message}`);
    }
  }
  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error(`[store] save failed: ${e.message}`);
    }
  }
  return { state, save };
}

// ---- http helpers ----

async function fetchTimeout(url, opts = {}, ms = 5000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Constant-time comparison of the X-Api-Key style header.
function checkKey(req, headerName, expected) {
  if (!expected) return false;
  const got = String(req.headers[headerName] || '');
  const a = Buffer.from(got);
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- event outbox ----
//
// Every event is written to the state file first, then delivered. If the
// partner is down or slow, delivery is retried with backoff (1s, 2s, 4s,
// ... capped at 30s), in order, and picked up again after a restart. With no
// URL configured, events are only recorded (delivered=true, local=true).

function createOutbox({ store, name, url, key }) {
  if (!Array.isArray(store.state.outbox)) store.state.outbox = [];
  let flushing = false;

  function prune() {
    const box = store.state.outbox;
    const delivered = box.filter((e) => e._delivered);
    if (delivered.length > 200) {
      const drop = new Set(delivered.slice(0, delivered.length - 200));
      store.state.outbox = box.filter((e) => !drop.has(e));
    }
  }

  function enqueue(evt) {
    const e = {
      eventId: uuid(),
      at: nowIso(),
      ...evt,
      _attempts: 0,
      _nextAt: 0,
      _delivered: !url,
      _local: !url,
      _dead: false,
    };
    store.state.outbox.push(e);
    prune();
    store.save();
    flush();
    return e;
  }

  async function flush() {
    if (flushing || !url) return;
    flushing = true;
    try {
      for (const e of store.state.outbox) {
        if (e._delivered || e._dead) continue;
        if (Date.now() < e._nextAt) break; // keep order: wait for the head
        const { _attempts, _nextAt, _delivered, _local, _dead, ...body } = e;
        try {
          const res = await fetchTimeout(
            url,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Api-Key': key || '' },
              body: JSON.stringify(body),
            },
            5000
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          e._delivered = true;
          store.save();
        } catch (err) {
          e._attempts += 1;
          e._nextAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(e._attempts, 5));
          if (e._attempts >= 20) e._dead = true;
          console.error(`[${name}] event ${e.event} delivery failed (attempt ${e._attempts}): ${err.message}`);
          store.save();
          break;
        }
      }
    } finally {
      flushing = false;
    }
  }

  setInterval(flush, 2000);

  return {
    enqueue,
    flush,
    pending: () => store.state.outbox.filter((e) => !e._delivered && !e._dead).length,
    list: () => store.state.outbox,
  };
}

module.exports = { uuid, nowIso, createStore, createOutbox, fetchTimeout, send, readJson, checkKey };
