// v1-learning.js
//
// UC3 on the provider side ("Naledi progresses through a continuous
// capability-development journey"): the parts beyond progress events, which
// live in v1-bpp.js.
//
//   identity links      Elevate (or another app) user <-> network practitioner
//   learning offerings  learning providers publish what they offer
//   learning discovery  a Beckn discover with type "learning" finds offerings
//                       for a capability gap (language, mode, region, cost,
//                       digital access, entry requirements)
//   enrolment           a Beckn confirm for "enrol:<offeringId>" is routed to
//                       the learning provider, who accepts or declines; an
//                       accepted enrolment records "enrolled" in her journey
//   capability profile  per capability: status, supporting Thabos,
//                       credentials and evidence other providers can reference
//
// State lives in the provider app's store (v1-bpp.js persists it): one
// database writer per app.

'use strict';

const { send, fetchTimeout, uuid, nowIso } = require('./netlib');

const DELIVERY = ['in_person', 'remote', 'blended'];
const ENROL = 'enrol:';
const str = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : undefined);
const strList = (v, max = 20) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x).slice(0, max).map((x) => x.slice(0, 100)) : []);
const lc = (v) => String(v || '').toLowerCase();
const refKey = (app, userId) => `${app}:${userId}`;

// Beckn status codes for an enrolment.
const CODE = { requested: 'DRAFT', enrolled: 'ACTIVE', declined: 'REJECTED', withdrawn: 'CANCELLED' };

module.exports = function createLearning({ S, save, log, emitSub, addProgress, sendCallback, readJson, matchUrl, matchKey, matchTimeoutMs }) {
  S.offerings = S.offerings || {};
  S.enrolments = S.enrolments || {};
  S.identity = S.identity || {};

  // ---- identity ----

  function resolve(user) {
    if (!user || !user.app || user.userId == null) return null;
    const l = S.identity[refKey(user.app, user.userId)];
    return l ? l.practitionerId : null;
  }

  // ---- offerings ----

  function cleanOffering(b) {
    const cost = b.cost === 'free' || b.cost === 0 ? { amount: 0 }
      : b.cost && typeof b.cost === 'object' && Number.isFinite(Number(b.cost.amount)) ? { amount: Number(b.cost.amount), ...(str(b.cost.currency, 10) ? { currency: str(b.cost.currency, 10) } : {}), ...(str(b.cost.fundedBy, 100) ? { fundedBy: str(b.cost.fundedBy, 100) } : {}) }
      : null;
    return Object.fromEntries(Object.entries({
      providerId: str(b.providerId, 200),
      providerName: str(b.providerName, 200),
      title: str(b.title, 200),
      description: str(b.description, 2000),
      capabilities: strList(b.capabilities),
      needTypes: strList(b.needTypes),
      languages: strList(b.languages),
      deliveryModes: strList(b.deliveryModes).filter((m) => DELIVERY.includes(m)),
      regions: strList(b.regions),
      cost,
      duration: str(b.duration, 100),
      schedule: str(b.schedule, 200),
      entryRequirements: str(b.entryRequirements, 500),
      needsDigitalAccess: typeof b.needsDigitalAccess === 'boolean' ? b.needsDigitalAccess : undefined,
      url: str(b.url, 500),
      thaboRef: b.thaboRef && b.thaboRef.app && b.thaboRef.userId != null ? { app: String(b.thaboRef.app), userId: String(b.thaboRef.userId) } : undefined,
    }).filter(([, v]) => v !== undefined && v !== null));
  }

  // Does an offering suit this search? Fields the offering leaves empty do not filter.
  function suits(o, q) {
    if (q.capability && !o.capabilities.includes(q.capability)) return false;
    if (q.needType && o.needTypes.length && !o.needTypes.includes(q.needType)) return false;
    if (q.language && o.languages.length && !o.languages.map(lc).includes(lc(q.language))) return false;
    if (q.deliveryMode && q.deliveryMode !== 'either' && o.deliveryModes.length && !o.deliveryModes.includes(q.deliveryMode) && !o.deliveryModes.includes('blended')) return false;
    const remoteOnly = o.deliveryModes.length && o.deliveryModes.every((m) => m === 'remote');
    if (q.region && o.regions.length && !remoteOnly && !o.regions.map(lc).includes(lc(q.region))) return false;
    if (q.maxCost != null && o.cost && o.cost.amount > Number(q.maxCost)) return false;
    if (q.digitalAccess === false && o.needsDigitalAccess) return false;
    return true;
  }

  const view = (o) => ({ type: 'learning_offering', ...o });

  // ---- discovery (Beckn discover, type "learning") ----

  async function handleDiscover(context, decoded) {
    const tx = context.transactionId;
    const q = {
      capability: decoded.capability, needType: decoded.needType, language: decoded.language, deliveryMode: decoded.deliveryMode,
      region: decoded.region, maxCost: decoded.maxCost, digitalAccess: decoded.digitalAccess,
    };
    let found = Object.values(S.offerings).filter((o) => suits(o, q));
    let source = 'local';
    if (matchUrl) {
      // An outside catalogue (e.g. Elevate's) can add offerings: same fields back.
      try {
        const u = new URLSearchParams(Object.entries({ ...q, practitionerId: decoded.practitionerId }).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]));
        const r = await fetchTimeout(`${matchUrl}${matchUrl.includes('?') ? '&' : '?'}${u}`, { headers: { 'X-Api-Key': matchKey } }, matchTimeoutMs);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = await r.json();
        const extra = (Array.isArray(body.offerings) ? body.offerings : []).filter((o) => o && o.offeringId && o.providerId)
          .map((o) => ({ ...cleanOffering(o), offeringId: String(o.offeringId), external: true }));
        found = [...found, ...extra.filter((o) => !found.some((f) => f.offeringId === o.offeringId))];
        source = 'local+partner';
      } catch (e) {
        log.warn('learning.match_failed', { transactionId: tx, url: matchUrl, error: e.message });
      }
    }
    // Remember what was offered, so an enrolment can be checked against it.
    S.learningSearches = S.learningSearches || {};
    S.learningSearches[tx] = { practitionerId: decoded.practitionerId || null, offerings: found.map((o) => ({ offeringId: o.offeringId, providerId: o.providerId, capabilities: o.capabilities, title: o.title, external: !!o.external })), at: nowIso() };
    const keys = Object.keys(S.learningSearches);
    if (keys.length > 2000) delete S.learningSearches[keys[0]];
    save();
    log.info('learning.search', { transactionId: tx, capability: q.capability, language: q.language, deliveryMode: q.deliveryMode, region: q.region, source, offeringIds: found.map((o) => o.offeringId) });
    await sendCallback({
      context: { ...context, action: 'on_discover', timestamp: nowIso() },
      message: {
        catalogs: [{
          id: 'catalog-learning',
          descriptor: { name: 'Learning offerings' },
          provider: { id: 'backbone', descriptor: { name: 'Digital Backbone' } },
          resources: found.map((o) => ({ id: o.offeringId, descriptor: { name: JSON.stringify(view(o)) } })),
        }],
      },
    });
  }

  // ---- enrolment (Beckn confirm / status / cancel on "enrol:<offeringId>") ----

  function enrolmentOf(message) {
    const contract = (message || {}).contract || {};
    const resource = (((contract.commitments || [])[0] || {}).resources || [])[0] || {};
    if (typeof resource.id !== 'string' || !resource.id.startsWith(ENROL)) return null;
    let sharedContext = null;
    const d = contract.descriptor || {};
    if (d.name === 'shared-context' && d.longDesc) {
      try { const c = JSON.parse(d.longDesc); if (c && typeof c === 'object' && !Array.isArray(c)) sharedContext = c; } catch (e) { /* ignore */ }
    }
    return { offeringId: resource.id.slice(ENROL.length), providerId: ((contract.participants || [])[0] || {}).id, sharedContext };
  }
  const isEnrolment = (message) => !!enrolmentOf(message);

  function contractFor(e, code) {
    const id = ENROL + e.offeringId;
    return {
      id: 'contract-' + id,
      participants: [{ id: e.providerId, descriptor: { name: e.providerId, code: 'provider' } }],
      commitments: [{
        id: 'commitment-' + id,
        descriptor: { name: id, code: id },
        status: { code },
        resources: [{ id, descriptor: { name: id }, quantity: { unitQuantity: 1, unitCode: 'ENROLMENT' } }],
        offer: { id: 'offer-' + id, resourceIds: [id] },
      }],
    };
  }

  function findEnrolment(txId, offeringId) {
    return Object.values(S.enrolments).find((e) => e.transactionId === txId && e.offeringId === offeringId);
  }

  function changed(e, from, extra = {}) {
    emitSub({
      event: 'enrolment.changed',
      transactionId: e.transactionId,
      practitionerId: e.practitionerId,
      providerId: e.providerId,
      status: e.status,
      payload: { enrolmentId: e.id, offeringId: e.offeringId, title: e.title, capabilities: e.capabilities, from, ...extra },
    });
  }

  function handleAction(action, context, message) {
    const req = enrolmentOf(message);
    const txId = context.transactionId;
    const reply = (act, code, e) => sendCallback({ context: { ...context, action: act, timestamp: nowIso() }, message: { contract: contractFor(e || req, code) } });
    let e = findEnrolment(txId, req.offeringId);

    if (action === 'confirm') {
      if (e && ['requested', 'enrolled'].includes(e.status)) return reply('on_confirm', CODE[e.status], e); // repeated
      const search = (S.learningSearches || {})[txId];
      const offering = S.offerings[req.offeringId] || (search && search.offerings.find((o) => o.offeringId === req.offeringId));
      if (!offering || offering.providerId !== req.providerId) {
        log.info('enrolment.rejected', { transactionId: txId, offeringId: req.offeringId, providerId: req.providerId, reason: 'unknown offering' });
        return reply('on_confirm', 'REJECTED');
      }
      const before = e ? e.status : null;
      e = e || { id: `enr-${uuid().slice(0, 8)}`, transactionId: txId, offeringId: req.offeringId, providerId: req.providerId };
      Object.assign(e, {
        practitionerId: (search && search.practitionerId) || e.practitionerId || null,
        title: offering.title || null,
        capabilities: offering.capabilities || [],
        status: 'requested',
        requestedAt: nowIso(),
        updatedAt: nowIso(),
        context, // to answer later with on_status
        ...(req.sharedContext ? { sharedContext: req.sharedContext } : {}),
      });
      if (!req.sharedContext) delete e.sharedContext;
      S.enrolments[e.id] = e;
      save();
      log.info('enrolment.requested', { transactionId: txId, enrolmentId: e.id, offeringId: e.offeringId, providerId: e.providerId, practitionerId: e.practitionerId, sharedFields: req.sharedContext ? Object.keys(req.sharedContext) : undefined });
      emitSub({
        event: 'enrolment.requested',
        transactionId: txId,
        practitionerId: e.practitionerId,
        providerId: e.providerId,
        status: 'requested',
        payload: { enrolmentId: e.id, offeringId: e.offeringId, title: e.title, capabilities: e.capabilities, from: before, ...(e.sharedContext ? { sharedContext: e.sharedContext } : {}) },
      });
      return reply('on_confirm', 'DRAFT', e);
    }

    if (action === 'status') return reply('on_status', e ? CODE[e.status] : 'REJECTED', e);

    if (action === 'cancel') {
      if (!e || !['requested', 'enrolled'].includes(e.status)) return reply('on_cancel', 'REJECTED', e);
      const from = e.status;
      e.status = 'withdrawn';
      e.updatedAt = nowIso();
      delete e.sharedContext;
      save();
      log.info('enrolment.withdrawn', { transactionId: txId, enrolmentId: e.id, from });
      changed(e, from);
      return reply('on_cancel', 'CANCELLED', e);
    }
    return null;
  }

  // ---- provider decision: accept (enrolled) or decline ----

  async function decide(b) {
    const e = S.enrolments[String(b.enrolmentId || '')];
    if (!e) return { code: 404, body: { error: 'unknown_enrolment' } };
    if (b.providerId && String(b.providerId) !== e.providerId) return { code: 409, body: { error: 'not_your_enrolment' } };
    const decision = b.decision || 'accept';
    if (!['accept', 'decline'].includes(decision)) return { code: 400, body: { error: 'invalid_request', message: 'decision must be "accept" or "decline"' } };
    const to = decision === 'accept' ? 'enrolled' : 'declined';
    if (e.status === to) return { code: 200, body: { enrolmentId: e.id, status: e.status, idempotent: true } };
    if (e.status !== 'requested') return { code: 409, body: { error: 'not_requested', status: e.status } };
    const from = e.status;
    e.status = to;
    e.updatedAt = nowIso();
    if (b.note) e.note = str(b.note, 500);
    if (to === 'declined') delete e.sharedContext;
    save();
    log.info('enrolment.decided', { transactionId: e.transactionId, enrolmentId: e.id, decision, providerId: e.providerId });
    // Proactive on_status: the practitioner side learns the outcome over the network.
    const r = await sendCallback({
      context: { ...e.context, action: 'on_status', messageId: uuid(), timestamp: nowIso() },
      message: { contract: contractFor(e, CODE[to]) },
    });
    if (!r.ok) log.warn('enrolment.notify_failed', { transactionId: e.transactionId, enrolmentId: e.id, detail: (r.text || r.error || '').slice(0, 300) });
    changed(e, from, b.note ? { note: str(b.note, 500) } : {});
    // Accepted: "enrolled" joins her journey, once per enrolment.
    if (to === 'enrolled' && e.practitionerId) {
      addProgress({
        eventId: `enrolment:${e.id}`,
        practitionerId: e.practitionerId,
        event: 'enrolled',
        source: { app: 'network', service: e.providerId },
        capability: e.capabilities[0],
        activity: { id: e.offeringId, title: e.title || undefined, kind: 'course' },
      });
    }
    return { code: 200, body: { enrolmentId: e.id, status: e.status, delivered: r.ok } };
  }

  // ---- capability profile ----

  const NEEDS_SUPPORT = ['support_requested', 'milestone_delayed', 'specialist_support_requested', 'practical_demonstration_required'];
  const DEVELOPING = ['module_completed', 'assessment_completed', 'observation_completed', 'practical_evidence_submitted'];

  function profile(practitionerId) {
    const events = (S.progress || []).filter((e) => e.practitionerId === practitionerId && e.capability).sort((a, b) => (a.at < b.at ? -1 : 1));
    const enrol = Object.values(S.enrolments).filter((e) => e.practitionerId === practitionerId);
    const caps = new Map();
    const of = (c) => { if (!caps.has(c)) caps.set(c, { capability: c, events: [], enrolments: [] }); return caps.get(c); };
    for (const e of events) of(e.capability).events.push(e);
    for (const e of enrol) for (const c of e.capabilities.length ? e.capabilities : []) of(c).enrolments.push(e);
    return [...caps.values()].map(({ capability, events: ev, enrolments: en }) => {
      const last = ev[ev.length - 1];
      const status = ev.some((e) => e.event === 'credential_earned') ? 'demonstrated'
        : last && NEEDS_SUPPORT.includes(last.event) ? 'needs_support'
        : ev.some((e) => DEVELOPING.includes(e.event)) ? 'developing'
        : 'in_progress';
      const thabos = new Map();
      for (const e of ev) if (e.thaboRef) thabos.set(refKey(e.thaboRef.app, e.thaboRef.userId), { ...e.thaboRef, lastAt: e.at });
      const ref = (e) => ({ progressId: e.id, at: e.at, event: e.event, ...(e.evidenceRef ? { evidenceRef: e.evidenceRef } : {}), ...(e.activity ? { activity: e.activity } : {}), source: e.source });
      return {
        capability,
        status,
        supportingThabos: [...thabos.values()],
        credentials: ev.filter((e) => e.event === 'credential_earned').map(ref),
        evidence: ev.filter((e) => ['practical_evidence_submitted', 'observation_completed', 'assessment_completed'].includes(e.event)).map(ref),
        enrolments: en.map((e) => ({ enrolmentId: e.id, offeringId: e.offeringId, title: e.title, providerId: e.providerId, status: e.status })),
        lastEvent: last ? { event: last.event, at: last.at } : null,
        eventsCount: ev.length,
      };
    });
  }

  // ---- internal HTTP (relayed from /v1/... by the practitioner app) ----
  // Returns true when it handled the request.

  const done = (...a) => { send(...a); return true; };

  async function route(req, res, path) {
    const q = () => Object.fromEntries(new URL(req.url, 'http://x').searchParams);

    if (path === '/internal/identity/links') {
      if (req.method === 'GET') {
        const p = q();
        if (p.app && p.userId) {
          const l = S.identity[refKey(p.app, p.userId)];
          return l ? done(res, 200, l) : done(res, 404, { error: 'unknown_user' });
        }
        if (!p.practitionerId) return done(res, 400, { error: 'invalid_request', message: 'practitionerId, or app and userId, is required' });
        const links = Object.values(S.identity).filter((l) => l.practitionerId === p.practitionerId);
        return done(res, 200, { practitionerId: p.practitionerId, links });
      }
      if (req.method === 'POST') {
        const b = await readJson(req);
        const practitionerId = str(b.practitionerId, 200);
        const app = str(b.app, 50);
        const userId = b.userId != null && String(b.userId) ? String(b.userId).slice(0, 200) : null;
        if (!practitionerId || !app || !userId) return done(res, 400, { error: 'invalid_request', message: 'practitionerId, app and userId are required' });
        const key = refKey(app, userId);
        const had = S.identity[key];
        if (had && had.practitionerId !== practitionerId) return done(res, 409, { error: 'already_linked', message: 'this app user is linked to another practitioner' });
        if (had) return done(res, 200, { ...had, idempotent: true });
        S.identity[key] = { practitionerId, app, userId, linkedAt: nowIso() };
        save();
        log.info('identity.linked', { practitionerId, app });
        return done(res, 201, S.identity[key]);
      }
      return done(res, 405, { error: 'method_not_allowed' });
    }

    if (path === '/internal/learning/offerings') {
      if (req.method === 'GET') {
        const p = q();
        const list = Object.values(S.offerings).filter((o) => (!p.providerId || o.providerId === p.providerId) && (!p.capability || o.capabilities.includes(p.capability)));
        return done(res, 200, { count: list.length, offerings: list });
      }
      if (req.method === 'POST') {
        const o = cleanOffering(await readJson(req));
        if (!o.providerId || !o.title) return done(res, 400, { error: 'invalid_request', message: 'providerId and title are required' });
        if (!o.capabilities.length) return done(res, 400, { error: 'invalid_request', message: 'capabilities must list at least one capability code' });
        o.offeringId = `lo-${uuid().slice(0, 8)}`;
        o.createdAt = nowIso();
        S.offerings[o.offeringId] = o;
        save();
        log.info('learning.offering_added', { offeringId: o.offeringId, providerId: o.providerId, capabilities: o.capabilities });
        return done(res, 201, o);
      }
      return done(res, 405, { error: 'method_not_allowed' });
    }
    const del = path.match(/^\/internal\/learning\/offerings\/([^/]+)$/);
    if (del && req.method === 'DELETE') {
      const id = decodeURIComponent(del[1]);
      if (!S.offerings[id]) return done(res, 404, { error: 'unknown_offering' });
      delete S.offerings[id];
      save();
      return done(res, 200, { offeringId: id, deleted: true });
    }

    if (path === '/internal/learning/enrolments' && req.method === 'GET') {
      const p = q();
      const list = Object.values(S.enrolments)
        .filter((e) => (!p.practitionerId || e.practitionerId === p.practitionerId) && (!p.providerId || e.providerId === p.providerId) && (!p.status || e.status === p.status) && (!p.transactionId || e.transactionId === p.transactionId))
        .map(({ context, ...rest }) => rest);
      return done(res, 200, { count: list.length, enrolments: list });
    }
    if (path === '/internal/learning/enrolment-decision' && req.method === 'POST') {
      const r = await decide(await readJson(req));
      return done(res, r.code, r.body);
    }

    if (path === '/internal/capabilities' && req.method === 'GET') {
      const p = q();
      if (!p.practitionerId) return done(res, 400, { error: 'invalid_request', message: 'practitionerId is required' });
      const caps = profile(p.practitionerId);
      return done(res, 200, { practitionerId: p.practitionerId, count: caps.length, capabilities: caps });
    }
    return false;
  }

  return { resolve, route, handleDiscover, handleAction, isEnrolment };
};
