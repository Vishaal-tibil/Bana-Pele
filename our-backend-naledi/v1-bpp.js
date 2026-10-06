// v1-bpp.js
//
// The provider-side layer inside backbone-bpp-server.js.
//
//   - Discover: asks the partner's backend who matches (MATCH_URL), or falls
//     back to the local seed data when no partner is configured, then answers
//     with on_discover and pushes a "practitioner.matched" event.
//   - Requests: when a select/init/confirm arrives, pushes a
//     "request.received" event; the partner answers through the internal
//     endpoints below (relayed from the buyer app's /v1/provider/*).
//   - Offers: sends a later, second on_discover on the practitioner's
//     original transaction, carrying the provider's offer.
//   - State: needs, providers, pending requests and undelivered events are
//     kept in a state file so a restart loses nothing.
//
// Internal endpoints (header x-internal-key):
//   POST /internal/offer      POST /internal/decision   POST /internal/complete
//   POST /internal/reset      GET  /internal/state      GET /internal/log/{tx}
//   GET  /internal/commitments             who holds which need (shared view, UC1)
//   GET|POST /internal/subscriptions       NGO webhooks for new matches / requests
//   DELETE /internal/subscriptions/{id}

'use strict';

const crypto = require('crypto');
const { createStore, createOutbox, send, readJson, checkKey, fetchTimeout, uuid, nowIso, OUTBOX_TABLE, TARGETED_OUTBOX_TABLE, outboxMapper } = require('./netlib');
const { COMMON_SCHEMA } = require('./db');

// ---- PostgreSQL tables (database naledi_bpp) ----

const SCHEMA = [
  ...COMMON_SCHEMA,
  // The provider directory (Impande, GROW, WeHelp, SmartStart, the Thabos ...).
  `CREATE TABLE IF NOT EXISTS providers (
     id                 text PRIMARY KEY,
     name               text NOT NULL,
     kind               text NOT NULL,
     need_types_covered jsonb NOT NULL DEFAULT '[]',
     region             text,
     coverage           jsonb,
     capacity           text,
     description        text,
     extra              jsonb NOT NULL DEFAULT '{}'
   )`,
  `CREATE TABLE IF NOT EXISTS naledis (
     id       text PRIMARY KEY,
     name     text NOT NULL,
     region   text,
     need_ids jsonb NOT NULL DEFAULT '[]'
   )`,
  // One need per practitioner + need type; status open -> reserved -> fulfilled.
  `CREATE TABLE IF NOT EXISTS needs (
     id          text PRIMARY KEY,
     naledi_id   text NOT NULL,
     type        text NOT NULL,
     status      text NOT NULL,
     provider_id text,
     coach_id    text,
     note        text NOT NULL DEFAULT '',
     extra       jsonb NOT NULL DEFAULT '{}'
   )`,
  `CREATE INDEX IF NOT EXISTS needs_naledi ON needs (naledi_id)`,
  // Requests waiting for a provider's decision (select/init or confirm).
  `CREATE TABLE IF NOT EXISTS pending_requests (
     id          text PRIMARY KEY,
     seq         integer NOT NULL,
     action      text NOT NULL,
     need_id     text,
     provider_id text,
     context     jsonb NOT NULL,
     message     jsonb NOT NULL
   )`,
  // What the provider side knows about each search (who matched, offers sent).
  // NGO subscriptions (UC1): who wants to be told about new matches and requests.
  `CREATE TABLE IF NOT EXISTS subscriptions (
     id           text PRIMARY KEY,
     url          text NOT NULL,
     secret       text NOT NULL,
     name         text,
     provider_ids jsonb NOT NULL DEFAULT '[]',
     need_types   jsonb NOT NULL DEFAULT '[]',
     regions      jsonb NOT NULL DEFAULT '[]',
     events       jsonb NOT NULL DEFAULT '[]',
     created_at   timestamptz NOT NULL
   )`,
  // Events waiting for / delivered to the subscriptions (one queue, a target per row).
  `CREATE TABLE IF NOT EXISTS sub_outbox (
     event_id        uuid PRIMARY KEY,
     seq             bigint NOT NULL,
     at              timestamptz NOT NULL,
     event           text NOT NULL,
     epoch           integer NOT NULL,
     transaction_id  text,
     practitioner_id text,
     provider_id     text,
     status          text,
     payload         jsonb NOT NULL DEFAULT '{}',
     attempts        integer NOT NULL DEFAULT 0,
     next_at         bigint NOT NULL DEFAULT 0,
     delivered       boolean NOT NULL DEFAULT false,
     local_only      boolean NOT NULL DEFAULT false,
     dead            boolean NOT NULL DEFAULT false,
     target          text
   )`,
  `CREATE INDEX IF NOT EXISTS sub_outbox_seq ON sub_outbox (seq)`,
  `CREATE TABLE IF NOT EXISTS tx_meta (
     transaction_id   text PRIMARY KEY,
     practitioner_id  text,
     need_type        text,
     region           text,
     provider_ids     jsonb NOT NULL DEFAULT '[]',
     discover_context jsonb,
     match_error      text,
     offers           jsonb NOT NULL DEFAULT '[]',
     created_at       timestamptz NOT NULL
   )`,
];

const TABLES = {
  meta: { pk: 'key', cols: ['key', 'value'], json: ['value'] },
  providers: { pk: 'id', order: 'id', cols: ['id', 'name', 'kind', 'need_types_covered', 'region', 'coverage', 'capacity', 'description', 'extra'], json: ['need_types_covered', 'coverage', 'extra'] },
  naledis: { pk: 'id', order: 'id', cols: ['id', 'name', 'region', 'need_ids'], json: ['need_ids'] },
  needs: { pk: 'id', order: 'id', cols: ['id', 'naledi_id', 'type', 'status', 'provider_id', 'coach_id', 'note', 'extra'], json: ['extra'] },
  pending_requests: { pk: 'id', order: 'seq', cols: ['id', 'seq', 'action', 'need_id', 'provider_id', 'context', 'message'], json: ['context', 'message'] },
  tx_meta: { pk: 'transaction_id', order: 'created_at', cols: ['transaction_id', 'practitioner_id', 'need_type', 'region', 'provider_ids', 'discover_context', 'match_error', 'offers', 'created_at'], json: ['provider_ids', 'discover_context', 'offers'] },
  outbox: OUTBOX_TABLE,
  subscriptions: { pk: 'id', order: 'created_at', cols: ['id', 'url', 'secret', 'name', 'provider_ids', 'need_types', 'regions', 'events', 'created_at'], json: ['provider_ids', 'need_types', 'regions', 'events'] },
  sub_outbox: TARGETED_OUTBOX_TABLE,
};

const pick = (o, known) => Object.fromEntries(Object.entries(o).filter(([key]) => !known.includes(key)));
const iso = (v) => (v instanceof Date ? v.toISOString() : v);

function bppDb(pool, log) {
  const ob = outboxMapper();
  const sob = outboxMapper();
  return {
    pool, log, name: 'bpp', schema: SCHEMA, tables: TABLES,
    toRows: (S) => {
      const snap = S.snapshot || { naledis: [], needs: [], providers: [], pending: [] };
      return {
        meta: [{ key: 'epoch', value: S.epoch }, { key: 'snapshot', value: !!S.snapshot }],
        providers: snap.providers.map((p) => ({
          id: p.id, name: p.name || p.id, kind: p.kind || 'NGO', need_types_covered: p.needTypesCovered || [], region: p.region,
          coverage: p.coverage || null, capacity: p.capacity, description: p.description,
          extra: pick(p, ['id', 'name', 'kind', 'needTypesCovered', 'region', 'coverage', 'capacity', 'description']),
        })),
        naledis: snap.naledis.map((n) => ({ id: n.id, name: n.name || n.id, region: n.region, need_ids: n.needIds || [] })),
        needs: snap.needs.map((n) => ({
          id: n.id, naledi_id: n.naledisId || '', type: n.type || '', status: n.status || 'open', provider_id: n.providerId, coach_id: n.coachId || null,
          note: n.note || '', extra: pick(n, ['id', 'naledisId', 'type', 'status', 'providerId', 'coachId', 'note']),
        })),
        pending_requests: snap.pending.map((p, i) => ({
          id: p.id, seq: i, action: p.action || '', need_id: p.needId, provider_id: p.providerId, context: p.context || {}, message: p.message || {},
        })),
        tx_meta: Object.entries(S.txMeta).map(([tx, m]) => ({
          transaction_id: tx, practitioner_id: m.practitionerId, need_type: m.needType, region: m.region, provider_ids: m.providerIds || [],
          discover_context: m.discoverContext || null, match_error: m.matchError || null, offers: m.offers || [], created_at: m.createdAt,
        })),
        outbox: ob.toRows(S.outbox),
        subscriptions: Object.values(S.subscriptions || {}).map((x) => ({
          id: x.id, url: x.url, secret: x.secret, name: x.name || null, provider_ids: x.providerIds, need_types: x.needTypes,
          regions: x.regions, events: x.events, created_at: x.createdAt,
        })),
        sub_outbox: sob.toRows(S.subOutbox),
      };
    },
    fromRows: (S, rows) => {
      const meta = Object.fromEntries(rows.meta.map((r) => [r.key, r.value]));
      if (meta.epoch !== undefined) S.epoch = Number(meta.epoch);
      S.snapshot = meta.snapshot
        ? {
            providers: rows.providers.map((r) => ({
              ...(r.extra || {}), id: r.id, name: r.name, kind: r.kind, needTypesCovered: r.need_types_covered || [], region: r.region,
              ...(r.coverage ? { coverage: r.coverage } : {}), capacity: r.capacity, description: r.description,
            })),
            naledis: rows.naledis.map((r) => ({ id: r.id, name: r.name, region: r.region, needIds: r.need_ids || [] })),
            needs: rows.needs.map((r) => ({
              ...(r.extra || {}), id: r.id, naledisId: r.naledi_id, type: r.type, status: r.status, providerId: r.provider_id,
              note: r.note, ...(r.coach_id ? { coachId: r.coach_id } : {}),
            })),
            pending: rows.pending_requests.map((r) => ({ id: r.id, action: r.action, context: r.context, message: r.message, needId: r.need_id, providerId: r.provider_id })),
          }
        : null;
      S.txMeta = {};
      for (const r of rows.tx_meta) {
        S.txMeta[r.transaction_id] = {
          practitionerId: r.practitioner_id, needType: r.need_type, region: r.region, providerIds: r.provider_ids || [],
          discoverContext: r.discover_context, matchError: r.match_error, offers: r.offers || [], createdAt: iso(r.created_at),
        };
      }
      S.outbox = ob.fromRows(rows.outbox);
      S.subscriptions = {};
      for (const r of rows.subscriptions) {
        S.subscriptions[r.id] = {
          id: r.id, url: r.url, secret: r.secret, name: r.name, providerIds: r.provider_ids || [], needTypes: r.need_types || [],
          regions: r.regions || [], events: r.events || [], createdAt: iso(r.created_at),
        };
      }
      S.subOutbox = sob.fromRows(rows.sub_outbox);
    },
  };
}

module.exports = function createV1Bpp(k) {
  const { log, pool } = k;
  const API_KEY = process.env.API_KEY || 'demo-key-change-me';
  const INTERNAL_KEY = process.env.INTERNAL_KEY || API_KEY;
  const MATCH_URL = process.env.MATCH_URL || '';
  const EVENTS_URL = process.env.EVENTS_URL || '';
  const EVENTS_API_KEY = process.env.EVENTS_API_KEY || API_KEY;
  const MATCH_TIMEOUT_MS = Number(process.env.MATCH_TIMEOUT_MS || 3000);
  // An offer is a later, second answer on the practitioner's search. 'new'
  // (default) gives it a fresh message id; 'reuse' repeats the original
  // discover's id (also accepted, but the adapters log a duplicate-id warning).
  const OFFER_MESSAGE_ID = process.env.OFFER_MESSAGE_ID || 'new';
  const STATE_FILE = process.env.STATE_FILE || '';
  const WAIT_FOR_REQUEST_MS = Number(process.env.WAIT_FOR_REQUEST_MS || 4000);

  const store = createStore(STATE_FILE, { epoch: 1, txMeta: {}, snapshot: null, outbox: [], subscriptions: {}, subOutbox: [] }, pool ? bppDb(pool, log) : null);
  const S = store.state;
  const outbox = createOutbox({ store, name: 'bpp-events', url: EVENTS_URL, key: EVENTS_API_KEY, log });
  // NGO subscriptions: same event shapes, delivered to each subscriber that asked for them.
  if (!S.subscriptions) S.subscriptions = {};
  const subOutbox = createOutbox({
    store, name: 'ngo-subscriptions', log, field: 'subOutbox',
    resolve: (e) => {
      const sub = S.subscriptions[e._target];
      return sub ? { url: sub.url, key: sub.secret } : null;
    },
  });
  const SUB_EVENTS = ['practitioner.matched', 'request.received', 'status.changed'];

  // ---- persistence of the legacy in-memory maps ----

  function persist() {
    S.snapshot = {
      naledis: [...k.naledis.values()],
      needs: [...k.needs.values()],
      providers: [...k.providers.values()],
      pending: [...k.pendingRequests],
    };
    store.save();
  }

  function restore() {
    const snap = S.snapshot;
    if (!snap) return false;
    k.naledis.clear();
    k.needs.clear();
    k.providers.clear();
    k.pendingRequests.length = 0;
    snap.naledis.forEach((n) => k.naledis.set(n.id, n));
    snap.needs.forEach((n) => k.needs.set(n.id, n));
    snap.providers.forEach((p) => k.providers.set(p.id, p));
    snap.pending.forEach((p) => k.pendingRequests.push(p));
    log.info('store.restored', { needs: snap.needs.length, pending: snap.pending.length, providers: snap.providers.length, epoch: S.epoch });
    return true;
  }

  // ---- needs are created on first sight, one per practitioner + type ----

  function ensureNeed(needId) {
    if (!needId || k.needs.has(needId)) return;
    const i = needId.lastIndexOf(':');
    if (i <= 0) return; // legacy ids (need-xxxx) only come from the seed
    const practitionerId = needId.slice(0, i);
    const type = needId.slice(i + 1);
    if (!k.NEED_TYPES.includes(type)) return;
    let naledi = k.naledis.get(practitionerId);
    if (!naledi) {
      naledi = { id: practitionerId, name: practitionerId, region: '', needIds: [] };
      k.naledis.set(practitionerId, naledi);
    }
    k.needs.set(needId, { id: needId, naledisId: practitionerId, type, status: 'open', providerId: null, note: '' });
    naledi.needIds.push(needId);
    log.info('need.created', { needId, practitionerId, needType: type, status: 'open' });
  }

  // ---- events to the partner ----

  function emit(event, e) {
    const evt = {
      event,
      epoch: S.epoch,
      transactionId: e.transactionId || null,
      practitionerId: e.practitionerId || null,
      providerId: e.providerId || null,
      status: e.status || null,
      payload: e.payload || {},
    };
    const queued = outbox.enqueue(evt);
    notifySubscribers(evt);
    return queued;
  }

  // ---- NGO subscriptions (UC1: tell NGOs about new matches and requests) ----

  const lc = (v) => String(v || '').toLowerCase();
  function subscriptionMatches(sub, evt) {
    if (sub.events.length && !sub.events.includes(evt.event)) return false;
    if (sub.providerIds.length && !sub.providerIds.includes(evt.providerId)) return false;
    const p = evt.payload || {};
    if (sub.needTypes.length && !sub.needTypes.includes(p.needType)) return false;
    if (sub.regions.length && !sub.regions.some((r) => lc(r) === lc(p.region))) return false;
    return true;
  }

  function notifySubscribers(evt) {
    for (const sub of Object.values(S.subscriptions)) {
      if (subscriptionMatches(sub, evt)) subOutbox.enqueue(evt, sub.id);
    }
  }

  function publicSubscription(sub) {
    const { secret, ...rest } = sub;
    return rest;
  }

  function cleanList(v, name) {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x)) throw Object.assign(new Error(`${name} must be a list of strings`), { status: 400 });
    return [...new Set(v)];
  }

  // ---- commitments: the per-Naledi shared view (UC1) ----

  function commitments(q) {
    const list = [...k.needs.values()].map((n) => {
      const provider = n.providerId ? k.providers.get(n.providerId) : null;
      const waiting = k.pendingRequests.find((p) => p.needId === n.id);
      const naledi = k.naledis.get(n.naledisId);
      return {
        needId: n.id,
        practitionerId: n.naledisId,
        needType: n.type,
        region: (S.txMeta[n.transactionId || (waiting && waiting.context && waiting.context.transactionId)] || {}).region || (naledi && naledi.region) || null,
        status: n.status,
        providerId: n.providerId || null,
        providerName: provider ? provider.name : null,
        coachId: n.coachId || null,
        transactionId: n.transactionId || null,
        updatedAt: n.updatedAt || null,
        awaitingDecision: waiting ? { stage: waiting.action === 'confirm' ? 'confirm' : 'select_init', providerId: waiting.providerId, transactionId: waiting.context && waiting.context.transactionId } : null,
      };
    });
    return list.filter(
      (c) =>
        (!q.practitionerId || c.practitionerId === q.practitionerId) &&
        (!q.status || c.status === q.status) &&
        (!q.providerId || c.providerId === q.providerId) &&
        (!q.needType || c.needType === q.needType) &&
        (!q.coachId || c.coachId === q.coachId)
    );
  }

  function onQueued(pending) {
    const need = k.needs.get(pending.needId) || {};
    emit('request.received', {
      transactionId: pending.context && pending.context.transactionId,
      practitionerId: need.naledisId,
      providerId: pending.providerId,
      status: 'awaiting_decision',
      payload: {
        stage: pending.action === 'confirm' ? 'confirm' : 'select_init', needId: pending.needId, needType: need.type,
        region: (S.txMeta[pending.context && pending.context.transactionId] || {}).region || (k.naledis.get(need.naledisId) || {}).region || null,
      },
    });
    persist();
  }

  // ---- discover ----

  async function handleDiscover(context, decoded) {
    const tx = context.transactionId;
    let matches = [];
    let matchError = null;

    if (MATCH_URL) {
      try {
        const q = new URLSearchParams({
          needType: decoded.needType || '',
          region: decoded.region || '',
          practitionerId: decoded.practitionerId || '',
          tier: decoded.tier || '',
          children: decoded.children == null ? '' : String(decoded.children),
        });
        const res = await fetchTimeout(
          `${MATCH_URL}${MATCH_URL.includes('?') ? '&' : '?'}${q}`,
          { headers: { 'X-Api-Key': EVENTS_API_KEY } },
          MATCH_TIMEOUT_MS
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        matches = (Array.isArray(body.matches) ? body.matches : []).filter((m) => m && m.providerId);
      } catch (e) {
        matchError = e.message;
        log.warn('match.lookup_failed', { transactionId: tx, url: MATCH_URL, error: e.message });
      }
    } else {
      matches = k
        .providersMatching(decoded.needType, decoded.region)
        .map((p) => ({ providerId: p.id, name: p.name, kind: p.kind, description: p.description, region: p.region, reasons: ['local match'] }));
    }

    log.info('match.result', { transactionId: tx, needType: decoded.needType, region: decoded.region, source: MATCH_URL ? 'partner' : 'local', providerIds: matches.map((m) => m.providerId), error: matchError || undefined });
    S.txMeta[tx] = {
      practitionerId: decoded.practitionerId || null,
      needType: decoded.needType || null,
      region: decoded.region || null,
      providerIds: matches.map((m) => m.providerId),
      discoverContext: context,
      matchError,
      offers: [],
      createdAt: nowIso(),
    };
    persist();

    await k.sendCallback({
      context: { ...context, action: 'on_discover', timestamp: nowIso() },
      message: {
        catalogs: [
          {
            id: 'catalog-backbone',
            descriptor: { name: 'Digital Backbone Provider Catalog' },
            provider: { id: 'backbone', descriptor: { name: 'Digital Backbone' } },
            resources: matches.map((m) => ({
              id: m.providerId,
              descriptor: {
                name: JSON.stringify({ name: m.name, kind: m.kind || 'NGO', description: m.description, region: m.region, reasons: m.reasons }),
              },
            })),
          },
        ],
      },
    });

    matches.forEach((m) =>
      emit('practitioner.matched', {
        transactionId: tx,
        practitionerId: decoded.practitionerId,
        providerId: m.providerId,
        status: 'matched',
        payload: { needType: decoded.needType, region: decoded.region, tier: decoded.tier, children: decoded.children, reasons: m.reasons || [] },
      })
    );
  }

  // ---- internal endpoints ----

  function findPending(tx, action) {
    return k.pendingRequests.find((p) => p.context && p.context.transactionId === tx && p.action === action);
  }

  function handle(req, res, path) {
    if (!path.startsWith('/internal/')) return false;
    route(req, res, path).catch((e) => {
      log.error('internal.error', { path, error: e.message, stack: e.stack });
      const bad = /invalid JSON|too large/.test(e.message);
      send(res, bad ? 400 : 500, { error: bad ? 'invalid_request' : 'internal_error', message: e.message });
    });
    return true;
  }

  async function route(req, res, path) {
    if (!checkKey(req, 'x-internal-key', INTERNAL_KEY)) {
      return send(res, 401, { error: 'unauthorized', message: 'missing or invalid x-internal-key' });
    }

    if (req.method === 'GET' && path === '/internal/state') {
      return send(res, 200, { epoch: S.epoch, txMeta: S.txMeta, pending: k.pendingRequests, needs: [...k.needs.values()], outbox: outbox.list(), subscriptionOutbox: subOutbox.list() });
    }

    const logMatch = path.match(/^\/internal\/log\/([^/]+)$/);
    if (req.method === 'GET' && logMatch) {
      return send(res, 200, (await log.readTx(decodeURIComponent(logMatch[1]))) || []);
    }

    if (req.method === 'GET' && path === '/internal/commitments') {
      const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      const list = commitments(q);
      return send(res, 200, { count: list.length, commitments: list });
    }

    if (path === '/internal/subscriptions' && req.method === 'GET') {
      return send(res, 200, Object.values(S.subscriptions).map(publicSubscription));
    }

    if (path === '/internal/subscriptions' && req.method === 'POST') {
      const b = await readJson(req);
      let u;
      try {
        u = new URL(String(b.url || ''));
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error('scheme');
      } catch (e) {
        return send(res, 400, { error: 'invalid_request', message: 'url must be an http(s) address' });
      }
      let sub;
      try {
        const events = cleanList(b.events, 'events');
        const unknown = events.filter((x) => !SUB_EVENTS.includes(x));
        if (unknown.length) return send(res, 400, { error: 'invalid_request', message: `unknown events: ${unknown.join(', ')}`, allowed: SUB_EVENTS });
        sub = {
          id: `sub-${uuid().slice(0, 8)}`,
          url: u.toString(),
          secret: b.secret ? String(b.secret) : crypto.randomBytes(24).toString('hex'),
          name: b.name ? String(b.name) : null,
          providerIds: cleanList(b.providerIds, 'providerIds'),
          needTypes: cleanList(b.needTypes, 'needTypes'),
          regions: cleanList(b.regions, 'regions'),
          events: events.length ? events : SUB_EVENTS.slice(0, 2),
          createdAt: nowIso(),
        };
      } catch (e) {
        return send(res, e.status || 400, { error: 'invalid_request', message: e.message });
      }
      S.subscriptions[sub.id] = sub;
      store.save();
      log.info('subscription.created', { subscriptionId: sub.id, url: sub.url, providerIds: sub.providerIds, needTypes: sub.needTypes, regions: sub.regions, events: sub.events });
      // The secret is returned once, here; later reads never show it.
      return send(res, 201, { ...publicSubscription(sub), secret: sub.secret });
    }

    const subDel = path.match(/^\/internal\/subscriptions\/([^/]+)$/);
    if (subDel && req.method === 'DELETE') {
      const id = decodeURIComponent(subDel[1]);
      if (!S.subscriptions[id]) return send(res, 404, { error: 'unknown_subscription' });
      delete S.subscriptions[id];
      store.save();
      log.info('subscription.deleted', { subscriptionId: id });
      return send(res, 200, { id, deleted: true });
    }

    if (req.method === 'POST' && path === '/internal/reset') {
      k.naledis.clear();
      k.needs.clear();
      k.providers.clear();
      k.pendingRequests.length = 0;
      k.seed();
      S.txMeta = {};
      S.outbox = [];
      S.subOutbox = []; // subscriptions themselves are configuration and survive a reset
      S.epoch += 1;
      persist();
      log.info('admin.reset', { epoch: S.epoch });
      return send(res, 200, { epoch: S.epoch });
    }

    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
    const b = await readJson(req);

    if (path === '/internal/decision' || path === '/internal/complete') {
      const stage = path === '/internal/decision' ? 'init' : 'confirm';
      if (!b.transactionId) return send(res, 400, { error: 'invalid_request', message: 'transactionId is required' });
      const decision = b.decision || 'accept';
      if (!['accept', 'decline'].includes(decision)) {
        return send(res, 400, { error: 'invalid_request', message: 'decision must be "accept" or "decline"' });
      }
      // The request travels through two adapters, so a caller that reacts very
      // quickly (accept, then assign a moment later) can get here first. Wait a
      // few seconds for it to arrive instead of failing.
      let p = findPending(b.transactionId, stage);
      const deadline = Date.now() + WAIT_FOR_REQUEST_MS;
      while (!p && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        p = findPending(b.transactionId, stage);
      }
      if (!p) {
        const early = stage === 'init' && findPending(b.transactionId, 'select');
        return send(res, early ? 409 : 404, { error: early ? 'request_not_ready' : 'no_pending_request', stage });
      }
      const approve = decision === 'accept';
      const need = k.needs.get(p.needId);
      if (approve && b.coachId && need) need.coachId = b.coachId;
      log.info('provider.decision', { transactionId: b.transactionId, needId: p.needId, stage, decision, coachId: b.coachId || undefined });
      k.resolvePending(p.id, approve);
      persist();
      const after = k.needs.get(p.needId);
      return send(res, 200, { ok: true, decision, stage, needId: p.needId, needStatus: after ? after.status : null });
    }

    if (path === '/internal/offer') {
      if (!b.transactionId || !b.providerId || !b.title) {
        return send(res, 400, { error: 'invalid_request', message: 'transactionId, providerId and title are required' });
      }
      const meta = S.txMeta[b.transactionId];
      if (!meta) return send(res, 404, { error: 'unknown_transaction' });
      if (!meta.providerIds.includes(b.providerId)) {
        return send(res, 409, { error: 'provider_not_matched', message: 'this provider did not match the practitioner\'s search' });
      }
      const offerId = b.offerId || `offer-${uuid().slice(0, 8)}`;
      const provider = k.providers.get(b.providerId);
      const providerName = b.providerName || (provider && provider.name) || b.providerId;
      const context = { ...meta.discoverContext, action: 'on_discover', timestamp: nowIso() };
      if (OFFER_MESSAGE_ID === 'new') context.messageId = uuid();
      const r = await k.sendCallback({
        context,
        message: {
          catalogs: [
            {
              id: 'catalog-offers',
              descriptor: { name: 'Offers' },
              provider: { id: 'backbone', descriptor: { name: 'Digital Backbone' } },
              resources: [
                {
                  id: offerId,
                  descriptor: {
                    name: JSON.stringify({ type: 'offer', offerId, title: b.title, area: b.area, note: b.note, providerId: b.providerId, providerName }),
                  },
                },
              ],
            },
          ],
        },
      });
      if (!r.ok) {
        return send(res, 502, { error: 'network_rejected', detail: (r.text || r.error || '').slice(0, 500) });
      }
      meta.offers.push(offerId);
      persist();
      log.info('offer.sent', { transactionId: b.transactionId, offerId, providerId: b.providerId, title: b.title });
      return send(res, 200, { offerId, status: 'sent' });
    }

    return send(res, 404, { error: 'not_found' });
  }

  // A need changed hands (reserved, fulfilled, reopened): tell the subscribed
  // NGOs, so a provider sees when another one has taken a need. The partner
  // already gets status.changed from the buyer side, so this goes to
  // subscriptions only.
  function onNeedStatus(need, before, pending) {
    if (need.status === before) return;
    const naledi = k.naledis.get(need.naledisId) || {};
    notifySubscribers({
      event: 'status.changed',
      epoch: S.epoch,
      transactionId: need.transactionId || null,
      practitionerId: need.naledisId || null,
      providerId: pending.providerId || null,
      status: need.status,
      payload: { needId: need.id, needType: need.type, region: (S.txMeta[need.transactionId] || {}).region || naledi.region || null, from: before, coachId: need.coachId || null },
    });
  }

  return { handle, handleDiscover, ensureNeed, onQueued, onNeedStatus, persist, restore, delegated: !!MATCH_URL, ready: store.ready, flush: store.flush };
};
