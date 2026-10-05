// netlib.js
//
// Tiny, zero-dependency helpers shared by the two Naledi translators
// (frontdoor-bap-server.js = buyer side, backbone-bpp-server.js = provider
// side):
//   - createStore   : the app's state, kept in PostgreSQL (db.js) or, without
//                     DATABASE_URL, in a JSON state file
//   - createOutbox  : events pushed to the partner's webhook, with retry and
//                     an order-preserving queue that survives a restart
//   - small HTTP helpers (json body, key check, fetch with timeout)

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

// ---- state ----
//
// createStore(file, initial, db?) returns { state, save, ready, flush }.
//   - with db (PostgreSQL, see db.js): the state is loaded from tables when
//     `ready` resolves, and every save() writes the rows that changed.
//   - without db: the old JSON state file, written atomically on every save.
// Callers keep working on `state` as a plain object either way.

function createStore(file, initial, db) {
  const state = JSON.parse(JSON.stringify(initial));
  if (db) {
    const { createSync, migrate } = require('./db');
    const sync = createSync({
      pool: db.pool,
      tables: db.tables,
      toRows: () => db.toRows(state),
      fromRows: (rows) => db.fromRows(state, rows),
      log: db.log,
      name: db.name,
    });
    const ready = (async () => {
      await migrate(db.pool, db.schema);
      await sync.load();
      db.log.info('store.loaded', { store: db.name, backend: 'postgres' });
    })();
    return { state, save: sync.save, ready, flush: sync.flush };
  }
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
    if (!file) return Promise.resolve();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error(`[store] save failed: ${e.message}`);
    }
    return Promise.resolve();
  }
  return { state, save, ready: Promise.resolve(), flush: () => Promise.resolve() };
}

// Outbox rows (same table in both apps). The order of the queue is kept in
// `seq`, remembered per event object.
const OUTBOX_TABLE = {
  pk: 'event_id',
  order: 'seq',
  cols: ['event_id', 'seq', 'at', 'event', 'epoch', 'transaction_id', 'practitioner_id', 'provider_id', 'status', 'payload', 'attempts', 'next_at', 'delivered', 'local_only', 'dead'],
  json: ['payload'],
};

function outboxMapper() {
  const seqOf = new WeakMap();
  let next = 0;
  return {
    toRows(box) {
      return (box || []).map((e) => {
        if (!seqOf.has(e)) seqOf.set(e, ++next);
        return {
          event_id: e.eventId, seq: seqOf.get(e), at: e.at, event: e.event, epoch: e.epoch,
          transaction_id: e.transactionId, practitioner_id: e.practitionerId, provider_id: e.providerId,
          status: e.status, payload: e.payload || {}, attempts: e._attempts || 0, next_at: e._nextAt || 0,
          delivered: !!e._delivered, local_only: !!e._local, dead: !!e._dead,
        };
      });
    },
    fromRows(rows) {
      return (rows || []).map((r) => {
        const e = {
          eventId: r.event_id, at: r.at instanceof Date ? r.at.toISOString() : r.at, event: r.event, epoch: r.epoch,
          transactionId: r.transaction_id, practitionerId: r.practitioner_id, providerId: r.provider_id,
          status: r.status, payload: r.payload || {}, _attempts: r.attempts, _nextAt: Number(r.next_at),
          _delivered: r.delivered, _local: r.local_only, _dead: r.dead,
        };
        const seq = Number(r.seq);
        seqOf.set(e, seq);
        if (seq > next) next = seq;
        return e;
      });
    },
  };
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

function createOutbox({ store, name, url, key, log }) {
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
    if (log) log.info('event.queued', { transactionId: e.transactionId, outbox: name, eventId: e.eventId, eventName: e.event, status: e.status, delivery: url ? 'webhook' : 'recorded-only' });
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
          if (log) log.info('event.delivered', { transactionId: e.transactionId, outbox: name, eventId: e.eventId, eventName: e.event, attempts: e._attempts + 1 });
        } catch (err) {
          e._attempts += 1;
          e._nextAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(e._attempts, 5));
          if (e._attempts >= 20) e._dead = true;
          if (log) log.warn('event.delivery_failed', { transactionId: e.transactionId, outbox: name, eventId: e.eventId, eventName: e.event, attempt: e._attempts, dead: e._dead, error: err.message });
          else console.error(`[${name}] event ${e.event} delivery failed (attempt ${e._attempts}): ${err.message}`);
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

module.exports = { uuid, nowIso, createStore, createOutbox, fetchTimeout, send, readJson, checkKey, OUTBOX_TABLE, outboxMapper };
