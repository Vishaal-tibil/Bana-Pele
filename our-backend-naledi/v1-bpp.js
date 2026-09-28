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
//   POST /internal/reset      GET  /internal/state

'use strict';

const { createStore, createOutbox, send, readJson, checkKey, fetchTimeout, uuid, nowIso } = require('./netlib');

module.exports = function createV1Bpp(k) {
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

  const store = createStore(STATE_FILE, { epoch: 1, txMeta: {}, snapshot: null, outbox: [] });
  const S = store.state;
  const outbox = createOutbox({ store, name: 'bpp-events', url: EVENTS_URL, key: EVENTS_API_KEY });

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
    console.log(`[v1-bpp] restored ${snap.needs.length} needs, ${snap.pending.length} pending request(s), ${snap.providers.length} providers`);
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
  }

  // ---- events to the partner ----

  function emit(event, e) {
    return outbox.enqueue({
      event,
      epoch: S.epoch,
      transactionId: e.transactionId || null,
      practitionerId: e.practitionerId || null,
      providerId: e.providerId || null,
      status: e.status || null,
      payload: e.payload || {},
    });
  }

  function onQueued(pending) {
    const need = k.needs.get(pending.needId) || {};
    emit('request.received', {
      transactionId: pending.context && pending.context.transactionId,
      practitionerId: need.naledisId,
      providerId: pending.providerId,
      status: 'awaiting_decision',
      payload: { stage: pending.action === 'confirm' ? 'confirm' : 'select_init', needId: pending.needId, needType: need.type },
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
        console.error(`[v1-bpp] match lookup failed (${e.message}) -- answering with no matches`);
      }
    } else {
      matches = k
        .providersMatching(decoded.needType, decoded.region)
        .map((p) => ({ providerId: p.id, name: p.name, kind: p.kind, description: p.description, region: p.region, reasons: ['local match'] }));
    }

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
      console.error('[v1-bpp] error:', e);
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
      return send(res, 200, { epoch: S.epoch, txMeta: S.txMeta, pending: k.pendingRequests, needs: [...k.needs.values()], outbox: outbox.list() });
    }

    if (req.method === 'POST' && path === '/internal/reset') {
      k.naledis.clear();
      k.needs.clear();
      k.providers.clear();
      k.pendingRequests.length = 0;
      k.seed();
      S.txMeta = {};
      S.outbox = [];
      S.epoch += 1;
      persist();
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
      return send(res, 200, { offerId, status: 'sent' });
    }

    return send(res, 404, { error: 'not_found' });
  }

  return { handle, handleDiscover, ensureNeed, onQueued, persist, restore, delegated: !!MATCH_URL };
};
