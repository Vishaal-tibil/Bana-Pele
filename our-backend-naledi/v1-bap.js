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
//   POST /v1/provider/offer      -> provider side (offer to the practitioner)
//   POST /v1/provider/decision   -> provider side (accept / decline + coach)
//   POST /v1/provider/complete   -> provider side (mark support delivered)
//   POST /v1/admin/reset         wipe state (both sides) for a fresh rehearsal
//   GET  /v1/health              liveness, no key needed
//
// Every call except /v1/health needs the header X-Api-Key.

'use strict';

const { createStore, createOutbox, send, readJson, checkKey, fetchTimeout, uuid, nowIso } = require('./netlib');

module.exports = function createV1Bap({ trigger }) {
  const API_KEY = process.env.API_KEY || 'demo-key-change-me';
  const INTERNAL_KEY = process.env.INTERNAL_KEY || API_KEY;
  const BACKBONE_BASE_URL = process.env.BACKBONE_BASE_URL || 'http://localhost:4001';
  const EVENTS_URL = process.env.EVENTS_URL || '';
  const EVENTS_API_KEY = process.env.EVENTS_API_KEY || API_KEY;
  const STATE_FILE = process.env.STATE_FILE || '';
  const DISCOVER_TTL = process.env.DISCOVER_TTL || undefined;

  const store = createStore(STATE_FILE, { epoch: 1, transactions: {}, outbox: [] });
  const S = store.state;
  const outbox = createOutbox({ store, name: 'bap-events', url: EVENTS_URL, key: EVENTS_API_KEY });

  if (API_KEY === 'demo-key-change-me') console.warn('[v1] API_KEY not set -- using the demo default. Set API_KEY before exposing this.');
  console.log(`[v1] buyer API ready (epoch ${S.epoch}, events -> ${EVENTS_URL || 'recorded only'})`);

  function note(tx, text, data) {
    tx.history.push({ at: nowIso(), text, ...(data ? { data } : {}) });
    if (tx.history.length > 100) tx.history.shift();
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

  function summary(tx) {
    return {
      transactionId: tx.transactionId,
      practitionerId: tx.practitionerId,
      needType: tx.needType,
      status: tx.order.status !== 'none' ? tx.order.status : tx.status,
      order: tx.order,
      resultsCount: tx.results.length,
      offersCount: tx.offers.length,
      createdAt: tx.createdAt,
    };
  }

  // ---- request handling ----

  function handle(req, res, path) {
    if (path !== '/v1' && !path.startsWith('/v1/')) return false;
    route(req, res, path).catch((e) => {
      console.error('[v1] error:', e);
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

    // ---- provider-side calls are relayed to the provider app on the internal network ----
    const providerMatch = path.match(/^\/v1\/provider\/(offer|decision|complete)$/);
    if (providerMatch) {
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      const body = await readJson(req);
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

    if (req.method === 'POST' && path === '/v1/search') {
      const b = await readJson(req);
      if (!b.practitionerId || !b.needType) {
        return send(res, 400, { error: 'invalid_request', message: 'practitionerId and needType are required' });
      }
      const transactionId = uuid();
      const tx = {
        transactionId,
        practitionerId: String(b.practitionerId),
        needType: String(b.needType),
        region: b.region ? String(b.region) : '',
        createdAt: nowIso(),
        status: 'searching',
        results: [],
        offers: [],
        order: { status: 'none', needId: null, providerId: null },
        history: [],
      };
      S.transactions[transactionId] = tx; // stored before sending: the callback can beat the ACK
      note(tx, 'search requested', { needType: tx.needType, region: tx.region });
      store.save();
      const r = await trigger(
        'discover',
        { needType: tx.needType, region: tx.region, practitionerId: tx.practitionerId, tier: b.tier, children: b.children },
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
      return send(res, 200, Object.values(S.transactions).map(summary));
    }

    if (req.method === 'GET' && path === '/v1/events') {
      return send(res, 200, outbox.list());
    }

    const txGet = path.match(/^\/v1\/(results|status|log)\/([^/]+)$/);
    if (req.method === 'GET' && txGet) {
      const tx = S.transactions[txGet[2]];
      if (!tx) return send(res, 404, { error: 'unknown_transaction' });
      if (txGet[1] === 'results') {
        return send(res, 200, { transactionId: tx.transactionId, status: tx.status, results: tx.results, offers: tx.offers });
      }
      if (txGet[1] === 'log') return send(res, 200, tx.history);
      return send(res, 200, { ...summary(tx), results: tx.results, offers: tx.offers, epoch: S.epoch });
    }

    if (req.method === 'POST' && path === '/v1/select') {
      const b = await readJson(req);
      if (!b.transactionId || !b.practitionerId || !b.needType || !b.providerId) {
        return send(res, 400, { error: 'invalid_request', message: 'transactionId, practitionerId, needType and providerId are required' });
      }
      const tx = S.transactions[b.transactionId];
      if (!tx) return send(res, 404, { error: 'unknown_transaction' });
      const busy = ['pending', 'reserved', 'confirming', 'fulfilled'].includes(tx.order.status);
      if (busy) {
        if (tx.order.providerId === b.providerId) return send(res, 200, { transactionId: tx.transactionId, status: tx.order.status, idempotent: true });
        return send(res, 409, { error: 'already_in_progress', status: tx.order.status, providerId: tx.order.providerId });
      }
      const needId = `${b.practitionerId}:${b.needType}`;
      tx.order = { status: 'pending', needId, providerId: b.providerId };
      note(tx, 'select requested', { needId, providerId: b.providerId });
      store.save();
      let r = await trigger('select', { needId, providerId: b.providerId }, tx.transactionId);
      if (r.ok) r = await trigger('init', { needId, providerId: b.providerId }, tx.transactionId);
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

    if (req.method === 'POST' && path === '/v1/admin/reset') {
      S.transactions = {};
      S.outbox = [];
      S.epoch += 1;
      store.save();
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

    if (action === 'on_discover') {
      const resources = ((msg.catalogs || [])[0] || {}).resources || [];
      for (const r of resources) {
        let d = {};
        try {
          d = JSON.parse(r.descriptor.name);
        } catch (e) {
          d = { name: r.descriptor && r.descriptor.name };
        }
        if (d.type === 'offer') {
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
    }
    store.save();
    return true;
  }

  return { handle, onCallback };
};
