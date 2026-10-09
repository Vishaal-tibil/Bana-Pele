// v1-bap.js
//
// The buyer-side REST layer that My Journey's backend calls. It sits inside
// frontdoor-bap-server.js and turns simple REST calls into real Beckn
// messages sent through onix-bap, and turns the on_* callbacks that come back
// into status changes and pushed events.
//
//   POST /v1/search              start a search for one practitioner
//   GET  /v1/results/{tx}        providers found + offers received
//   POST /v1/select              request a provider (sends select + init)
//   POST /v1/confirm             confirm once reserved
//   GET  /v1/status/{tx}         current status of the whole transaction
//   POST /v1/status/{tx}/refresh ask the provider side again (Beckn status / on_status)
//   GET  /v1/log/{tx}            the transaction's full log, both sides (from the database)
//   POST /v1/provider/offer      -> provider side (offer to the practitioner)
//   POST /v1/provider/decision   -> provider side (accept / decline + coach)
//   POST /v1/provider/complete   -> provider side (mark support delivered)
//   POST /v1/provider/register   -> provider side (add a new NGO/Thabo to the directory)
//   POST /v1/provider/refer      -> provider side (redirect Naledi to another Thabo, UC2)
//   POST /v1/provider/contribution -> provider side (record support, actions, follow-ups, UC2)
//   POST /v1/consent/revoke      Naledi takes back the context she shared (UC2)
//   GET  /v1/commitments         who holds which need (per-Naledi shared view, UC1)
//   POST /v1/progress            push a capability-journey event (UC3, e.g. Elevate project-service)
//   GET  /v1/progress            a practitioner's journey (UC3)
//   GET|POST /v1/subscriptions   NGO webhooks: new matches, requests, status changes (UC1)
//   DELETE /v1/subscriptions/{id}
//   POST /v1/admin/reset         wipe state (both sides) for a fresh rehearsal
//   GET  /v1/health              liveness, no key needed
//
// Every call except /v1/health needs the header X-Api-Key.

'use strict';

const { createStore, createOutbox, send, readJson, checkKey, fetchTimeout, uuid, nowIso, OUTBOX_TABLE, outboxMapper } = require('./netlib');
const { COMMON_SCHEMA } = require('./db');

// ---- PostgreSQL tables (database naledi_bap) ----

const SCHEMA = [
  ...COMMON_SCHEMA,
  `CREATE TABLE IF NOT EXISTS transactions (
     transaction_id  text PRIMARY KEY,
     practitioner_id text NOT NULL,
     need_type       text NOT NULL,
     region          text NOT NULL DEFAULT '',
     status          text NOT NULL,
     order_status    text NOT NULL DEFAULT 'none',
     need_id         text,
     provider_id     text,
     results         jsonb NOT NULL DEFAULT '[]',
     offers          jsonb NOT NULL DEFAULT '[]',
     created_at      timestamptz NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS transactions_practitioner ON transactions (practitioner_id)`,
  // What the practitioner wrote when asking (title, description); added later, hence ALTER.
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS request jsonb`,
];

const TABLES = {
  meta: { pk: 'key', cols: ['key', 'value'], json: ['value'] },
  transactions: {
    pk: 'transaction_id',
    order: 'created_at',
    cols: ['transaction_id', 'practitioner_id', 'need_type', 'region', 'status', 'order_status', 'need_id', 'provider_id', 'results', 'offers', 'created_at', 'request'],
    json: ['results', 'offers', 'request'],
  },
  outbox: OUTBOX_TABLE,
};

function bapDb(pool, log) {
  const ob = outboxMapper();
  return {
    pool, log, name: 'bap', schema: SCHEMA, tables: TABLES,
    toRows: (S) => ({
      meta: [{ key: 'epoch', value: S.epoch }],
      transactions: Object.values(S.transactions).map((tx) => ({
        transaction_id: tx.transactionId, practitioner_id: tx.practitionerId, need_type: tx.needType,
        region: tx.region || '', status: tx.status, order_status: tx.order.status, need_id: tx.order.needId,
        provider_id: tx.order.providerId, results: tx.results, offers: tx.offers, created_at: tx.createdAt,
        request: tx.title || tx.description || tx.language || tx.deliveryMode || tx.urgency || tx.roles || tx.excludeThaboRefs || tx.kind
          ? {
            title: tx.title || null, description: tx.description || null, language: tx.language || null, deliveryMode: tx.deliveryMode || null, urgency: tx.urgency || null,
            roles: tx.roles || null, excludeThaboRefs: tx.excludeThaboRefs || null, referrals: tx.referrals && tx.referrals.length ? tx.referrals : null,
            ...(tx.kind ? { kind: tx.kind, learning: tx.learning || null, enrolments: tx.enrolments || [] } : {}),
          }
          : tx.referrals && tx.referrals.length ? { referrals: tx.referrals } : null,
      })),
      outbox: ob.toRows(S.outbox),
    }),
    fromRows: (S, rows) => {
      const epoch = rows.meta.find((r) => r.key === 'epoch');
      if (epoch) S.epoch = Number(epoch.value);
      S.transactions = {};
      for (const r of rows.transactions) {
        S.transactions[r.transaction_id] = {
          transactionId: r.transaction_id, practitionerId: r.practitioner_id, needType: r.need_type, region: r.region,
          createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at, status: r.status,
          results: r.results || [], offers: r.offers || [],
          ...(r.request ? {
            title: r.request.title || undefined, description: r.request.description || undefined, language: r.request.language || undefined,
            deliveryMode: r.request.deliveryMode || undefined, urgency: r.request.urgency || undefined, roles: r.request.roles || undefined,
            excludeThaboRefs: r.request.excludeThaboRefs || undefined, referrals: r.request.referrals || undefined,
            ...(r.request.kind ? { kind: r.request.kind, learning: r.request.learning || undefined, enrolments: r.request.enrolments || [] } : {}),
          } : {}),
          order: { status: r.order_status, needId: r.need_id, providerId: r.provider_id },
          history: [], // the full history lives in tx_log
        };
      }
      S.outbox = ob.fromRows(rows.outbox);
    },
  };
}

module.exports = function createV1Bap({ trigger, log, pool }) {
  const API_KEY = process.env.API_KEY || 'demo-key-change-me';
  const INTERNAL_KEY = process.env.INTERNAL_KEY || API_KEY;
  const BACKBONE_BASE_URL = process.env.BACKBONE_BASE_URL || 'http://localhost:4001';
  const EVENTS_URL = process.env.EVENTS_URL || '';
  const EVENTS_API_KEY = process.env.EVENTS_API_KEY || API_KEY;
  const STATE_FILE = process.env.STATE_FILE || '';
  const DISCOVER_TTL = process.env.DISCOVER_TTL || undefined;
  const DELIVERY_MODES = ['in_person', 'remote', 'either'];
  const URGENCIES = ['low', 'normal', 'high'];
  const SHARED_CONTEXT_MAX = 4000;
  const ROLE_CODE = /^[a-z][a-z0-9_]{1,63}$/;
  const isThaboRef = (r) => r && typeof r === 'object' && typeof r.app === 'string' && r.app && r.userId != null && String(r.userId) !== '';

  const store = createStore(STATE_FILE, { epoch: 1, transactions: {}, outbox: [] }, pool ? bapDb(pool, log) : null);
  const S = store.state;
  const outbox = createOutbox({ store, name: 'bap-events', url: EVENTS_URL, key: EVENTS_API_KEY, log });

  if (API_KEY === 'demo-key-change-me') log.warn('config.demo_api_key', { message: 'API_KEY not set -- using the demo default. Set API_KEY before exposing this.' });
  const ready = store.ready.then(() => {
    log.info('v1.ready', { epoch: S.epoch, transactions: Object.keys(S.transactions).length, events: EVENTS_URL || 'recorded only', storage: pool ? 'postgres' : STATE_FILE ? 'file' : 'memory' });
  });

  // A state change on a transaction: kept on the transaction (short, in
  // memory) and written to the structured log (persistent, see logger.js).
  function note(tx, text, data) {
    tx.history.push({ at: nowIso(), text, ...(data ? { data } : {}) });
    if (tx.history.length > 100) tx.history.shift();
    log.info('tx.state', { transactionId: tx.transactionId, text, status: tx.status, orderStatus: tx.order.status, ...(data ? { data } : {}) });
  }

  function emit(event, tx, extra = {}) {
    return outbox.enqueue({
      event,
      epoch: S.epoch,
      transactionId: tx.transactionId,
      practitionerId: tx.practitionerId,
      providerId: extra.providerId || tx.order.providerId || null,
      status: extra.status || null,
      payload: extra.payload || {},
    });
  }

  // ---- Beckn status: catching up on missed callbacks ----
  // A request still waiting on the provider side (pending, confirming,
  // withdrawing) is checked automatically: on the first sweep after a
  // restart, then at most once per STATUS_RECHECK_MS. STATUS_SWEEP_MS=0 turns
  // the sweep off; POST /v1/status/{tx}/refresh still works.
  const STATUS_SWEEP_MS = Number(process.env.STATUS_SWEEP_MS ?? 300000);
  const STATUS_RECHECK_MS = Number(process.env.STATUS_RECHECK_MS ?? 1800000);
  const WAITING = ['pending', 'confirming', 'withdrawing'];
  const lastChecked = new Map(); // transactionId -> ms; in memory, so a restart checks everything once
  const selectedAt = new Map(); // transactionId -> ms of the last select (in memory)
  const SELECT_GRACE_MS = Number(process.env.STATUS_SELECT_GRACE_MS ?? 30000);

  function checkStatus(tx, why) {
    lastChecked.set(tx.transactionId, Date.now());
    note(tx, 'status check sent', { why, orderStatus: tx.order.status });
    return trigger('status', { needId: tx.order.needId, providerId: tx.order.providerId }, tx.transactionId);
  }

  // UC3: ask the learning provider where enrolments stand that are still
  // waiting on it (requested, withdrawing), e.g. after a missed on_status.
  async function checkEnrolments(tx, why) {
    lastChecked.set(tx.transactionId, Date.now());
    let last = { ok: true };
    for (const e of (tx.enrolments || []).filter((x) => ['requested', 'enrolled', 'withdrawing'].includes(x.status) && (why !== 'sweep' || x.status !== 'enrolled'))) {
      note(tx, 'status check sent', { why, offeringId: e.offeringId });
      const r = await trigger('status', { needId: `enrol:${e.offeringId}`, providerId: e.providerId }, tx.transactionId);
      if (!r.ok) last = r;
    }
    return last;
  }

  async function sweep() {
    const now = Date.now();
    const due = Object.values(S.transactions).filter(
      (tx) => (tx.kind === 'learning'
        ? (tx.enrolments || []).some((e) => ['requested', 'withdrawing'].includes(e.status))
        : WAITING.includes(tx.order.status) && tx.order.needId && tx.order.providerId) &&
        now - (lastChecked.get(tx.transactionId) || 0) >= STATUS_RECHECK_MS
    );
    for (const tx of due) {
      const r = tx.kind === 'learning' ? await checkEnrolments(tx, 'sweep') : await checkStatus(tx, 'sweep');
      if (!r.ok) log.warn('status.check_failed', { transactionId: tx.transactionId, detail: (r.text || r.error || '').slice(0, 300) });
    }
    if (due.length) log.info('status.sweep', { checked: due.length });
  }

  // on_status -> this side's order status. Only moves that the code proves
  // are applied; anything else is left as it is.
  function applyStatus(tx, code) {
    const cur = tx.order.status;
    if (code === 'COMPLETED' && !['fulfilled', 'withdrawn'].includes(cur)) return 'fulfilled';
    if (code === 'CANCELLED' && [...WAITING, 'reserved'].includes(cur)) return 'withdrawn';
    if (code === 'ACTIVE' && cur === 'pending') return 'reserved';
    // REJECTED also means "nothing held for this transaction", which is briefly
    // true while a fresh select is still on its way to the provider side.
    if (code === 'REJECTED' && cur === 'pending' && Date.now() - (selectedAt.get(tx.transactionId) || 0) > SELECT_GRACE_MS) return 'rejected';
    // Withdrawing a request the provider had already declined: nothing to withdraw.
    if (code === 'REJECTED' && cur === 'withdrawing' && tx.order.withdrawnFrom === 'pending') return 'rejected';
    return cur;
  }

  if (STATUS_SWEEP_MS > 0) {
    ready.then(() => {
      const t = setInterval(() => sweep().catch((e) => log.error('status.sweep_failed', { error: e.message })), STATUS_SWEEP_MS);
      if (t.unref) t.unref();
    });
  }

  function summary(tx) {
    return {
      transactionId: tx.transactionId,
      practitionerId: tx.practitionerId,
      needType: tx.needType,
      title: tx.title || null,
      description: tx.description || null,
      language: tx.language || null,
      deliveryMode: tx.deliveryMode || null,
      urgency: tx.urgency || null,
      roles: tx.roles || null,
      referralsCount: (tx.referrals || []).length,
      ...(tx.kind === 'learning' ? { kind: 'learning', learning: tx.learning, enrolments: tx.enrolments || [] } : {}),
      status: tx.order.status !== 'none' ? tx.order.status : tx.status,
      order: tx.order,
      resultsCount: tx.results.length,
      offersCount: tx.offers.length,
      createdAt: tx.createdAt,
    };
  }

  // ---- UC3: enrolment answers from the learning provider ----
  const NEED_TYPE_LEARNING = 'learning-skilling';
  function learningCallback(tx, action, msg) {
    const contract = msg.contract || {};
    const commitment = (contract.commitments || [])[0] || {};
    const resourceId = ((commitment.resources || [])[0] || {}).id || '';
    const code = (commitment.status || {}).code;
    const en = (tx.enrolments || []).find((e) => `enrol:${e.offeringId}` === resourceId);
    if (!en) return note(tx, `ignored ${action}: not one of this search's enrolments`, { resourceId });
    const from = en.status;
    let to = from;
    if (action === 'on_confirm') to = code === 'REJECTED' ? 'rejected' : from;
    else if (action === 'on_status') to = { ACTIVE: 'enrolled', REJECTED: from === 'requested' ? 'declined' : from, CANCELLED: 'withdrawn' }[code] || from;
    else if (action === 'on_cancel') to = code === 'CANCELLED' ? 'withdrawn' : from === 'withdrawing' ? en.withdrawnFrom || 'requested' : from;
    if (to === from) return note(tx, `${action}: enrolment ${en.offeringId} stays ${from}`, { code });
    en.status = to;
    en.updatedAt = nowIso();
    if (from === 'withdrawing') delete en.withdrawnFrom;
    note(tx, `enrolment ${en.offeringId}: ${from} -> ${to}`, { code });
    emit('enrolment.changed', tx, { providerId: en.providerId, status: to, payload: { offeringId: en.offeringId, title: en.title, from, code } });
  }

  // ---- request handling ----

  function handle(req, res, path) {
    if (path !== '/v1' && !path.startsWith('/v1/')) return false;
    const started = Date.now();
    res.on('finish', () => {
      if (path === '/v1/health') return;
      const m = path.match(/^\/v1\/(?:results|status|log)\/([^/]+)$/);
      log.info('api.request', { transactionId: m ? m[1] : res.txId, method: req.method, path, status: res.statusCode, ms: Date.now() - started });
    });
    route(req, res, path).catch((e) => {
      log.error('api.error', { path, error: e.message, stack: e.stack });
      const bad = /invalid JSON|too large/.test(e.message);
      send(res, bad ? 400 : 500, { error: bad ? 'invalid_request' : 'internal_error', message: e.message });
    });
    return true;
  }

  async function route(req, res, path) {
    if (req.method === 'GET' && path === '/v1/health') {
      return send(res, 200, {
        ok: true,
        epoch: S.epoch,
        eventsConfigured: !!EVENTS_URL,
        outboxPending: outbox.pending(),
        transactions: Object.keys(S.transactions).length,
      });
    }

    if (!checkKey(req, 'x-api-key', API_KEY)) {
      return send(res, 401, { error: 'unauthorized', message: 'missing or invalid X-Api-Key' });
    }

    // ---- shared view and NGO subscriptions live on the provider side; relayed as-is ----
    const relayPath =
      (req.method === 'GET' && path === '/v1/commitments') ||
      (['GET', 'POST'].includes(req.method) && path === '/v1/progress') ||
      (['GET', 'POST'].includes(req.method) && ['/v1/learning/offerings', '/v1/identity/links'].includes(path)) ||
      (req.method === 'DELETE' && /^\/v1\/learning\/offerings\/[^/]+$/.test(path)) ||
      (req.method === 'GET' && ['/v1/learning/enrolments', '/v1/capabilities'].includes(path)) ||
      (req.method === 'POST' && path === '/v1/learning/enrolment-decision') ||
      (['GET', 'POST'].includes(req.method) && path === '/v1/subscriptions') ||
      (req.method === 'DELETE' && /^\/v1\/subscriptions\/[^/]+$/.test(path));
    if (relayPath) {
      const qs = new URL(req.url, 'http://x').search;
      const body = req.method === 'POST' ? JSON.stringify(await readJson(req)) : undefined;
      let r;
      try {
        r = await fetchTimeout(
          `${BACKBONE_BASE_URL}/internal/${path.slice('/v1/'.length)}${req.method === 'GET' ? qs : ''}`,
          { method: req.method, headers: { 'x-internal-key': INTERNAL_KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body },
          8000
        );
      } catch (e) {
        return send(res, 502, { error: 'provider_side_unreachable', message: e.message });
      }
      const text = await r.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text }; }
      return send(res, r.status, parsed);
    }

    // ---- provider-side calls are relayed to the provider app on the internal network ----
    // POST /v1/consent/revoke is Naledi's, but the shared context lives on the provider side.
    const providerMatch = path.match(/^\/v1\/provider\/(offer|decision|complete|register|refer|contribution)$/) ||
      (path === '/v1/consent/revoke' && [null, 'revoke-context']);
    if (providerMatch) {
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      const body = await readJson(req);
      res.txId = body.transactionId;
      let r;
      try {
        r = await fetchTimeout(
          `${BACKBONE_BASE_URL}/internal/${providerMatch[1]}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_KEY }, body: JSON.stringify(body) },
          8000
        );
      } catch (e) {
        return send(res, 502, { error: 'provider_side_unreachable', message: e.message });
      }
      const text = await r.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text }; }
      return send(res, r.status, parsed);
    }

    // ---- UC3: learning search, enrolment, withdrawal (Beckn discover / confirm / cancel) ----
    if (req.method === 'POST' && path === '/v1/learning/search') {
      const b = await readJson(req);
      if (!b.practitionerId || !b.capability) return send(res, 400, { error: 'invalid_request', message: 'practitionerId and capability are required' });
      if (typeof b.capability !== 'string' || !ROLE_CODE.test(b.capability)) return send(res, 400, { error: 'invalid_request', message: 'capability must be a code like "nutrition_planning"' });
      if (b.deliveryMode != null && !DELIVERY_MODES.includes(b.deliveryMode)) return send(res, 400, { error: 'invalid_request', message: `deliveryMode must be one of ${DELIVERY_MODES.join(', ')}` });
      if (b.maxCost != null && !(Number.isFinite(Number(b.maxCost)) && Number(b.maxCost) >= 0)) return send(res, 400, { error: 'invalid_request', message: 'maxCost must be a number, 0 or more' });
      if (b.digitalAccess != null && typeof b.digitalAccess !== 'boolean') return send(res, 400, { error: 'invalid_request', message: 'digitalAccess must be true or false' });
      const learning = Object.fromEntries(Object.entries({
        capability: b.capability, language: b.language ? String(b.language).slice(0, 20) : undefined, region: b.region ? String(b.region).slice(0, 100) : undefined,
        deliveryMode: b.deliveryMode, maxCost: b.maxCost != null ? Number(b.maxCost) : undefined, digitalAccess: b.digitalAccess,
      }).filter(([, v]) => v !== undefined));
      const transactionId = uuid();
      res.txId = transactionId;
      const tx = {
        transactionId, practitionerId: String(b.practitionerId), needType: NEED_TYPE_LEARNING, region: learning.region || '',
        kind: 'learning', learning, enrolments: [], createdAt: nowIso(), status: 'searching', results: [], offers: [],
        order: { status: 'none', needId: null, providerId: null }, history: [],
      };
      S.transactions[transactionId] = tx;
      note(tx, 'learning search requested', learning);
      store.save();
      const r = await trigger('discover', { type: 'learning', practitionerId: tx.practitionerId, needType: NEED_TYPE_LEARNING, ...learning }, transactionId, { ttl: DISCOVER_TTL });
      if (!r.ok) {
        tx.status = 'error';
        note(tx, 'network rejected the search', { detail: r.text || r.error });
        store.save();
        return send(res, 502, { transactionId, status: 'error', error: 'network_rejected', detail: (r.text || r.error || '').slice(0, 500) });
      }
      return send(res, 202, { transactionId, status: 'searching', epoch: S.epoch });
    }

    if (req.method === 'POST' && (path === '/v1/learning/enrol' || path === '/v1/learning/withdraw')) {
      const b = await readJson(req);
      res.txId = b.transactionId;
      if (!b.transactionId || !b.offeringId) return send(res, 400, { error: 'invalid_request', message: 'transactionId and offeringId are required' });
      const tx = S.transactions[b.transactionId];
      if (!tx) return send(res, 404, { error: 'unknown_transaction' });
      if (tx.kind !== 'learning') return send(res, 409, { error: 'not_a_learning_search', message: 'enrolment needs a transaction from POST /v1/learning/search' });
      const offering = tx.results.find((o) => o.offeringId === String(b.offeringId));
      if (!offering) return send(res, 404, { error: 'unknown_offering', message: 'this offering was not in the search results' });
      tx.enrolments = tx.enrolments || [];
      let en = tx.enrolments.find((e) => e.offeringId === offering.offeringId);
      const needId = `enrol:${offering.offeringId}`;

      if (path === '/v1/learning/enrol') {
        if (en && ['requested', 'enrolled'].includes(en.status)) return send(res, 200, { transactionId: tx.transactionId, offeringId: en.offeringId, status: en.status, idempotent: true });
        let sharedContext;
        if (b.sharedContext != null) {
          if (typeof b.sharedContext !== 'object' || Array.isArray(b.sharedContext)) return send(res, 400, { error: 'invalid_request', message: 'sharedContext must be an object' });
          if (JSON.stringify(b.sharedContext).length > SHARED_CONTEXT_MAX) return send(res, 400, { error: 'invalid_request', message: `sharedContext is too large (max ${SHARED_CONTEXT_MAX} characters)` });
          sharedContext = b.sharedContext;
        }
        if (!en) { en = { offeringId: offering.offeringId, providerId: offering.providerId, title: offering.title || null }; tx.enrolments.push(en); }
        Object.assign(en, { status: 'requested', requestedAt: nowIso() });
        note(tx, 'enrolment requested', { offeringId: en.offeringId, providerId: en.providerId, ...(sharedContext ? { sharedFields: Object.keys(sharedContext) } : {}) });
        store.save();
        const r = await trigger('confirm', { needId, providerId: offering.providerId, sharedContext }, tx.transactionId);
        if (!r.ok) {
          en.status = 'error';
          note(tx, 'network rejected the enrolment', { detail: r.text || r.error });
          store.save();
          return send(res, 502, { transactionId: tx.transactionId, offeringId: en.offeringId, status: 'error', error: 'network_rejected', detail: (r.text || r.error || '').slice(0, 500) });
        }
        return send(res, 202, { transactionId: tx.transactionId, offeringId: en.offeringId, status: 'requested' });
      }

      if (!en || ['withdrawn', 'withdrawing'].includes(en.status)) return send(res, en ? 200 : 404, en ? { transactionId: tx.transactionId, offeringId: en.offeringId, status: en.status, idempotent: true } : { error: 'not_enrolled' });
      if (!['requested', 'enrolled'].includes(en.status)) return send(res, 409, { error: 'nothing_to_withdraw', status: en.status });
      en.withdrawnFrom = en.status;
      en.status = 'withdrawing';
      note(tx, 'enrolment withdrawal requested', { offeringId: en.offeringId });
      store.save();
      const r = await trigger('cancel', { needId, providerId: en.providerId }, tx.transactionId);
      if (!r.ok) {
        en.status = en.withdrawnFrom;
        delete en.withdrawnFrom;
        store.save();
        return send(res, 502, { transactionId: tx.transactionId, offeringId: en.offeringId, status: en.status, error: 'network_rejected', detail: (r.text || r.error || '').slice(0, 500) });
      }
      return send(res, 202, { transactionId: tx.transactionId, offeringId: en.offeringId, status: 'withdrawing' });
    }

    if (req.method === 'POST' && path === '/v1/search') {
      const b = await readJson(req);
      if (!b.practitionerId || !b.needType) {
        return send(res, 400, { error: 'invalid_request', message: 'practitionerId and needType are required' });
      }
      // UC2 preferences, passed to matching: language (any code, e.g. "zu"),
      // deliveryMode (a filter) and urgency (ordering only).
      const bad = (v, allowed) => v != null && v !== '' && !allowed.includes(v);
      if (bad(b.deliveryMode, DELIVERY_MODES)) return send(res, 400, { error: 'invalid_request', message: `deliveryMode must be one of ${DELIVERY_MODES.join(', ')}` });
      if (bad(b.urgency, URGENCIES)) return send(res, 400, { error: 'invalid_request', message: `urgency must be one of ${URGENCIES.join(', ')}` });
      // roles: the kinds of Thabo her need calls for, as taxonomy codes
      // (e.g. "social_worker"); excludeThaboRefs: people she already works with.
      if (b.roles != null && !(Array.isArray(b.roles) && b.roles.length <= 10 && b.roles.every((r) => typeof r === 'string' && ROLE_CODE.test(r)))) {
        return send(res, 400, { error: 'invalid_request', message: 'roles must be a list of up to 10 role codes like "ecd_coach"' });
      }
      if (b.excludeThaboRefs != null && !(Array.isArray(b.excludeThaboRefs) && b.excludeThaboRefs.length <= 50 && b.excludeThaboRefs.every(isThaboRef))) {
        return send(res, 400, { error: 'invalid_request', message: 'excludeThaboRefs must be a list of up to 50 { app, userId }' });
      }
      const transactionId = uuid();
      res.txId = transactionId;
      const tx = {
        transactionId,
        practitionerId: String(b.practitionerId),
        needType: String(b.needType),
        region: b.region ? String(b.region) : '',
        title: b.title ? String(b.title).slice(0, 200) : undefined,
        description: b.description ? String(b.description).slice(0, 2000) : undefined,
        language: b.language ? String(b.language).slice(0, 20) : undefined,
        deliveryMode: b.deliveryMode || undefined,
        urgency: b.urgency || undefined,
        roles: b.roles && b.roles.length ? b.roles : undefined,
        excludeThaboRefs: b.excludeThaboRefs && b.excludeThaboRefs.length ? b.excludeThaboRefs.map((r) => ({ app: String(r.app), userId: String(r.userId) })) : undefined,
        createdAt: nowIso(),
        status: 'searching',
        results: [],
        offers: [],
        order: { status: 'none', needId: null, providerId: null },
        history: [],
      };
      S.transactions[transactionId] = tx; // stored before sending: the callback can beat the ACK
      note(tx, 'search requested', { needType: tx.needType, region: tx.region, language: tx.language, deliveryMode: tx.deliveryMode, urgency: tx.urgency, roles: tx.roles, excluded: tx.excludeThaboRefs ? tx.excludeThaboRefs.length : undefined });
      store.save();
      const r = await trigger(
        'discover',
        { needType: tx.needType, region: tx.region, practitionerId: tx.practitionerId, tier: b.tier, children: b.children, title: tx.title, description: tx.description, language: tx.language, deliveryMode: tx.deliveryMode, urgency: tx.urgency, roles: tx.roles, excludeThaboRefs: tx.excludeThaboRefs },
        transactionId,
        { ttl: DISCOVER_TTL }
      );
      if (!r.ok) {
        tx.status = 'error';
        note(tx, 'network rejected the search', { detail: r.text || r.error });
        store.save();
        return send(res, 502, { transactionId, status: 'error', error: 'network_rejected', detail: (r.text || r.error || '').slice(0, 500) });
      }
      return send(res, 202, { transactionId, status: 'searching', epoch: S.epoch });
    }

    if (req.method === 'GET' && path === '/v1/transactions') {
      const who = new URL(req.url, 'http://x').searchParams.get('practitionerId');
      const list = Object.values(S.transactions).filter((t) => !who || t.practitionerId === who);
      return send(res, 200, list.map(summary));
    }

    if (req.method === 'GET' && path === '/v1/events') {
      return send(res, 200, outbox.list());
    }

    const txGet = path.match(/^\/v1\/(results|status|log)\/([^/]+)$/);
    if (req.method === 'GET' && txGet && txGet[1] === 'log' && pool) {
      // Persistent log: our own entries plus the provider side's, in time order.
      const mine = await log.readTx(txGet[2]);
      let theirs = [];
      try {
        const r = await fetchTimeout(`${BACKBONE_BASE_URL}/internal/log/${encodeURIComponent(txGet[2])}`, { headers: { 'x-internal-key': INTERNAL_KEY } }, 5000);
        if (r.ok) theirs = await r.json();
      } catch (e) {
        log.warn('log.provider_side_unavailable', { transactionId: txGet[2], error: e.message });
      }
      const all = [...mine, ...(Array.isArray(theirs) ? theirs : [])].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      if (!all.length && !S.transactions[txGet[2]]) return send(res, 404, { error: 'unknown_transaction' });
      return send(res, 200, all);
    }
    if (req.method === 'GET' && txGet) {
      const tx = S.transactions[txGet[2]];
      if (!tx) return send(res, 404, { error: 'unknown_transaction' });
      if (txGet[1] === 'results') {
        return send(res, 200, { transactionId: tx.transactionId, status: tx.status, results: tx.results, offers: tx.offers, referrals: tx.referrals || [] });
      }
      if (txGet[1] === 'log') return send(res, 200, tx.history);
      return send(res, 200, { ...summary(tx), results: tx.results, offers: tx.offers, referrals: tx.referrals || [], epoch: S.epoch });
    }

    if (req.method === 'POST' && path === '/v1/select') {
      const b = await readJson(req);
      res.txId = b.transactionId;
      if (!b.transactionId || !b.practitionerId || !b.needType || !b.providerId) {
        return send(res, 400, { error: 'invalid_request', message: 'transactionId, practitionerId, needType and providerId are required' });
      }
      const tx = S.transactions[b.transactionId];
      if (!tx) return send(res, 404, { error: 'unknown_transaction' });
      const busy = ['pending', 'reserved', 'confirming', 'fulfilled', 'withdrawing'].includes(tx.order.status);
      if (busy) {
        if (tx.order.providerId === b.providerId) return send(res, 200, { transactionId: tx.transactionId, status: tx.order.status, idempotent: true });
        return send(res, 409, { error: 'already_in_progress', status: tx.order.status, providerId: tx.order.providerId });
      }
      // What Naledi allows this Thabo to see (UC2): an object, sent only to the
      // provider she selected.
      let sharedContext;
      if (b.sharedContext != null) {
        if (typeof b.sharedContext !== 'object' || Array.isArray(b.sharedContext)) return send(res, 400, { error: 'invalid_request', message: 'sharedContext must be an object' });
        if (JSON.stringify(b.sharedContext).length > SHARED_CONTEXT_MAX) return send(res, 400, { error: 'invalid_request', message: `sharedContext is too large (max ${SHARED_CONTEXT_MAX} characters)` });
        sharedContext = b.sharedContext;
      }
      const needId = `${b.practitionerId}:${b.needType}`;
      tx.order = { status: 'pending', needId, providerId: b.providerId };
      selectedAt.set(tx.transactionId, Date.now());
      // Only which fields were shared goes in the log, not their values.
      note(tx, 'select requested', { needId, providerId: b.providerId, ...(sharedContext ? { sharedFields: Object.keys(sharedContext) } : {}) });
      store.save();
      let r = await trigger('select', { needId, providerId: b.providerId, sharedContext }, tx.transactionId);
      if (r.ok) r = await trigger('init', { needId, providerId: b.providerId, sharedContext }, tx.transactionId);
      if (!r.ok) {
        tx.order.status = 'error';
        note(tx, 'network rejected select/init', { detail: r.text || r.error });
        store.save();
        return send(res, 502, { transactionId: tx.transactionId, status: 'error', error: 'network_rejected', detail: (r.text || r.error || '').slice(0, 500) });
      }
      return send(res, 202, { transactionId: tx.transactionId, status: 'pending' });
    }

    if (req.method === 'POST' && path === '/v1/confirm') {
      const b = await readJson(req);
      res.txId = b.transactionId;
      if (!b.transactionId) return send(res, 400, { error: 'invalid_request', message: 'transactionId is required' });
      const tx = S.transactions[b.transactionId];
      if (!tx) return send(res, 404, { error: 'unknown_transaction' });
      if (tx.order.status === 'confirming' || tx.order.status === 'fulfilled') {
        return send(res, 200, { transactionId: tx.transactionId, status: tx.order.status, idempotent: true });
      }
      if (tx.order.status !== 'reserved') {
        return send(res, 409, { error: 'not_reserved', status: tx.order.status, message: 'confirm needs a reserved request' });
      }
      tx.order.status = 'confirming';
      note(tx, 'confirm requested', { note: b.note || null });
      store.save();
      const r = await trigger('confirm', { needId: tx.order.needId, providerId: tx.order.providerId, note: b.note }, tx.transactionId);
      if (!r.ok) {
        tx.order.status = 'reserved';
        note(tx, 'network rejected confirm', { detail: r.text || r.error });
        store.save();
        return send(res, 502, { transactionId: tx.transactionId, status: 'reserved', error: 'network_rejected', detail: (r.text || r.error || '').slice(0, 500) });
      }
      return send(res, 202, { transactionId: tx.transactionId, status: 'confirming' });
    }

    // Ask the provider side where the request stands (Beckn status). The
    // answer (on_status) corrects this side if a callback was missed, for
    // example while the app was restarting. Read the result with GET /v1/status.
    const refresh = path.match(/^\/v1\/status\/([^/]+)\/refresh$/);
    if (req.method === 'POST' && refresh) {
      const txId = decodeURIComponent(refresh[1]);
      res.txId = txId;
      const tx = S.transactions[txId];
      if (!tx) return send(res, 404, { error: 'unknown_transaction' });
      if (tx.kind === 'learning') {
        if (!(tx.enrolments || []).some((e) => ['requested', 'enrolled', 'withdrawing'].includes(e.status))) {
          return send(res, 409, { error: 'nothing_to_check', message: 'no enrolment has been requested yet' });
        }
        await checkEnrolments(tx, 'requested');
        return send(res, 202, { transactionId: tx.transactionId, enrolments: tx.enrolments, checking: true });
      }
      if (!tx.order.needId || !tx.order.providerId) {
        return send(res, 409, { error: 'nothing_to_check', status: summary(tx).status, message: 'no provider has been asked yet' });
      }
      const r = await checkStatus(tx, 'requested');
      if (!r.ok) {
        return send(res, 502, { transactionId: tx.transactionId, status: tx.order.status, error: 'network_rejected', detail: (r.text || r.error || '').slice(0, 500) });
      }
      return send(res, 202, { transactionId: tx.transactionId, status: tx.order.status, checking: true });
    }

    // Naledi no longer needs the help: withdraw the request (Beckn cancel).
    if (req.method === 'POST' && path === '/v1/withdraw') {
      const b = await readJson(req);
      res.txId = b.transactionId;
      if (!b.transactionId) return send(res, 400, { error: 'invalid_request', message: 'transactionId is required' });
      const tx = S.transactions[b.transactionId];
      if (!tx) return send(res, 404, { error: 'unknown_transaction' });
      const st = tx.order.status;
      if (st === 'withdrawn' || st === 'withdrawing') return send(res, 200, { transactionId: tx.transactionId, status: st, idempotent: true });
      if (st === 'fulfilled') return send(res, 409, { error: 'already_fulfilled', status: st, message: 'the support was already delivered' });
      if (!['pending', 'reserved', 'confirming'].includes(st)) {
        // Nobody holds anything for this request yet: close it here.
        const before = tx.order.status !== 'none' ? tx.order.status : tx.status;
        tx.order.status = 'withdrawn';
        note(tx, 'withdrawn before any provider took it', { reason: b.reason || null });
        emit('status.changed', tx, { status: 'withdrawn', payload: { needId: tx.order.needId, from: before, reason: b.reason || null } });
        store.save();
        return send(res, 200, { transactionId: tx.transactionId, status: 'withdrawn' });
      }
      tx.order.status = 'withdrawing';
      tx.order.withdrawnFrom = st;
      note(tx, 'withdraw requested', { reason: b.reason || null });
      store.save();
      const r = await trigger('cancel', { needId: tx.order.needId, providerId: tx.order.providerId }, tx.transactionId);
      if (!r.ok) {
        tx.order.status = st;
        note(tx, 'network rejected cancel', { detail: r.text || r.error });
        store.save();
        return send(res, 502, { transactionId: tx.transactionId, status: st, error: 'network_rejected', detail: (r.text || r.error || '').slice(0, 500) });
      }
      return send(res, 202, { transactionId: tx.transactionId, status: 'withdrawing' });
    }

    if (req.method === 'POST' && path === '/v1/admin/reset') {
      S.transactions = {};
      S.outbox = [];
      S.epoch += 1;
      store.save();
      log.info('admin.reset', { epoch: S.epoch });
      let providerSide = 'ok';
      try {
        const r = await fetchTimeout(
          `${BACKBONE_BASE_URL}/internal/reset`,
          { method: 'POST', headers: { 'x-internal-key': INTERNAL_KEY } },
          8000
        );
        if (!r.ok) providerSide = `HTTP ${r.status}`;
      } catch (e) {
        providerSide = e.message;
      }
      return send(res, 200, { epoch: S.epoch, providerSide });
    }

    return send(res, 404, { error: 'not_found' });
  }

  // ---- callbacks coming back from the network ----
  // Returns true when the callback belongs to a /v1 transaction.

  function onCallback(action, incoming) {
    const c = incoming.context || {};
    const tx = S.transactions[c.transactionId];
    if (!tx) return false;
    const msg = incoming.message || {};
    note(tx, `received ${action}`);
    if (tx.kind === 'learning' && action !== 'on_discover') {
      learningCallback(tx, action, msg);
      store.save();
      return true;
    }

    if (action === 'on_discover') {
      const resources = ((msg.catalogs || [])[0] || {}).resources || [];
      for (const r of resources) {
        let d = {};
        try {
          d = JSON.parse(r.descriptor.name);
        } catch (e) {
          d = { name: r.descriptor && r.descriptor.name };
        }
        if (d.type === 'learning_offering') {
          if (!tx.results.find((x) => x.offeringId === r.id)) tx.results.push({ ...d, offeringId: r.id });
        } else if (d.type === 'referral') {
          // A Thabo redirected Naledi to another Thabo (UC2): the referred Thabo
          // joins her results, so she can select them on this same request.
          const to = d.referTo || {};
          if (to.providerId && !(tx.referrals || []).some((x) => x.referralId === d.referralId)) {
            const referral = { referralId: d.referralId, fromProviderId: d.fromProviderId, referTo: to, note: d.note || null, receivedAt: nowIso() };
            tx.referrals = [...(tx.referrals || []), referral];
            const known = tx.results.find((x) => x.providerId === to.providerId);
            if (known) known.referredBy = d.fromProviderId;
            else tx.results.push({ ...to, referredBy: d.fromProviderId });
            emit('referral.received', tx, { providerId: to.providerId, status: 'referred', payload: referral });
          }
        } else if (d.type === 'offer') {
          const offerId = d.offerId || r.id;
          if (!tx.offers.find((o) => o.offerId === offerId)) {
            const offer = { offerId, title: d.title, area: d.area, note: d.note, providerId: d.providerId, providerName: d.providerName, receivedAt: nowIso() };
            tx.offers.push(offer);
            emit('offer.received', tx, { providerId: offer.providerId, status: 'offered', payload: offer });
          }
        } else if (!tx.results.find((x) => x.providerId === r.id)) {
          tx.results.push({ providerId: r.id, ...d });
        }
      }
      if (tx.status === 'searching') tx.status = 'results_ready';
    } else if (action === 'on_init' || action === 'on_confirm') {
      const contract = msg.contract || {};
      const code = (((contract.commitments || [])[0] || {}).status || {}).code;
      const before = tx.order.status;
      if (action === 'on_init') {
        if (code === 'ACTIVE') tx.order.status = 'reserved';
        else if (code === 'REJECTED') tx.order.status = 'rejected';
      } else if (code === 'COMPLETED') {
        tx.order.status = 'fulfilled';
      } else if (code === 'REJECTED') {
        tx.order.status = 'reserved';
      }
      if (tx.order.status !== before || (action === 'on_confirm' && code === 'REJECTED')) {
        emit('status.changed', tx, { status: tx.order.status, payload: { needId: tx.order.needId, code, from: before } });
      }
    } else if (action === 'on_status') {
      const contract = msg.contract || {};
      const code = (((contract.commitments || [])[0] || {}).status || {}).code || (contract.status || {}).code;
      const before = tx.order.status;
      const after = applyStatus(tx, code);
      note(tx, 'status checked', { code, from: before, to: after });
      if (after !== before) {
        tx.order.status = after;
        if (before === 'withdrawing') delete tx.order.withdrawnFrom;
        log.info('status.corrected', { transactionId: tx.transactionId, code, from: before, to: after });
        emit('status.changed', tx, { status: after, payload: { needId: tx.order.needId, code, from: before, via: 'status' } });
      }
    } else if (action === 'on_cancel') {
      const contract = msg.contract || {};
      const code = (((contract.commitments || [])[0] || {}).status || {}).code || (contract.status || {}).code;
      const before = tx.order.status;
      if (code === 'CANCELLED') tx.order.status = 'withdrawn';
      else if (before === 'withdrawing') tx.order.status = tx.order.withdrawnFrom || 'reserved'; // refused: back to where it was
      delete tx.order.withdrawnFrom;
      if (tx.order.status !== before) emit('status.changed', tx, { status: tx.order.status, payload: { needId: tx.order.needId, code, from: before } });
    }
    store.save();
    return true;
  }

  return { handle, onCallback, ready, flush: store.flush };
};
