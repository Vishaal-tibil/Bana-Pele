// network-kit -- everything a partner's Express backend needs to join the
// network. Drop this folder into your project (Node 18+, Express 4+, no other
// dependencies) and wire it in with about ten lines; see ../README.md.
//
//   networkRouter({ apiKey, match, onEvent })   the two endpoints the network calls
//       GET  /network/health
//       GET  /network/match    -> asks your rules "does this provider match?"
//       POST /network/events   -> hands you each network event, once
//   networkClient({ baseUrl, apiKey })          calls into the network
//       search, results, status, offer, select, decision, confirm, complete, reset, health
//   matchOrgProfile(query, orgProfile, opts)    a ready-made matching rule that
//       reads an organisation profile (capabilities, coverage, tiers)
//
// The client never throws and does nothing when baseUrl / apiKey are unset, so
// your app keeps working with its own logic if the network is missing or down:
// every call resolves to { ok, status, data } (or { ok:false, skipped:true }).

'use strict';

const crypto = require('crypto');

// Support area (as written in an organisation profile) -> need type on the network.
const NEED_AREAS = {
  Registration: 'registration',
  Infrastructure: 'infrastructure',
  'Learning & Skilling': 'learning-skilling',
  'Health & Safety': 'health-safety',
  Nutrition: 'nutrition',
  'Child Development': 'child-development',
  'Business / Financial Support': 'fundraising',
};

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------
// Inbound: the endpoints the network calls on you
// ---------------------------------------------------------------------------

function networkRouter({ apiKey, match, onEvent, log = console }) {
  if (!apiKey) throw new Error('networkRouter: apiKey is required (the shared secret the network sends in X-Api-Key)');
  if (typeof match !== 'function') throw new Error('networkRouter: match(query) must be a function returning an array of matches');
  if (typeof onEvent !== 'function') throw new Error('networkRouter: onEvent(event) must be a function');

  const express = require('express');
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  // Events can be delivered more than once (the network retries until you
  // answer 2xx). Remember the ids you have handled and skip repeats.
  const seen = new Set();
  const order = [];
  const remember = (id) => {
    seen.add(id);
    order.push(id);
    if (order.length > 5000) seen.delete(order.shift());
  };

  const auth = (req, res, next) =>
    safeEqual(req.get('x-api-key'), apiKey) ? next() : res.status(401).json({ error: 'unauthorized' });

  // Public on purpose: lets the network operator check the address is right.
  router.get('/network/health', (req, res) => res.json({ ok: true }));

  router.get('/network/match', auth, async (req, res) => {
    const q = {
      needType: String(req.query.needType || ''),
      region: String(req.query.region || ''),
      practitionerId: String(req.query.practitionerId || ''),
      tier: String(req.query.tier || ''),
      children: req.query.children === undefined || req.query.children === '' ? null : Number(req.query.children),
    };
    try {
      const matches = await match(q);
      res.json({ matches: Array.isArray(matches) ? matches : [] });
    } catch (e) {
      log.error('[network] match failed:', e.message);
      res.status(500).json({ error: 'match_failed' });
    }
  });

  router.post('/network/events', auth, async (req, res) => {
    const e = req.body || {};
    if (!e.eventId || !e.event) return res.status(400).json({ error: 'invalid_event' });
    if (e.event === 'ping') return res.json({ ok: true });
    if (seen.has(e.eventId)) return res.json({ ok: true, duplicate: true });
    try {
      await onEvent(e);
      remember(e.eventId); // only after success: a failed handler is retried by the network
      res.json({ ok: true });
    } catch (err) {
      log.error(`[network] handling ${e.event} failed:`, err.message);
      res.status(500).json({ error: 'handler_failed' });
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Outbound: calling the network
// ---------------------------------------------------------------------------

function networkClient({ baseUrl, apiKey, timeoutMs = 8000, log = console } = {}) {
  const enabled = !!(baseUrl && apiKey);
  const base = enabled ? String(baseUrl).replace(/\/+$/, '') : '';

  async function call(method, path, body) {
    if (!enabled) return { ok: false, skipped: true, status: 0 };
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(base + path, {
        method,
        headers: { 'X-Api-Key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
      let data = null;
      try { data = await res.json(); } catch (e) { /* no body */ }
      if (!res.ok) log.warn(`[network] ${method} ${path} -> ${res.status} ${data && (data.error || data.message) || ''}`);
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      log.warn(`[network] ${method} ${path} failed: ${e.message}`);
      return { ok: false, status: 0, error: e.message };
    } finally {
      clearTimeout(t);
    }
  }

  return {
    enabled,
    health: () => call('GET', '/v1/health'),
    // Naledi signs up: { practitionerId, needType, region, tier, children } -> data.transactionId
    search: (b) => call('POST', '/v1/search', b),
    results: (tx) => call('GET', `/v1/results/${tx}`),
    status: (tx) => call('GET', `/v1/status/${tx}`),
    // WeHelp sends the offer: { transactionId, providerId, title, area, note }
    offer: (b) => call('POST', '/v1/provider/offer', b),
    // Naledi accepts: { transactionId, practitionerId, needType, providerId }
    select: (b) => call('POST', '/v1/select', b),
    // WeHelp assigns a coach (or declines): { transactionId, decision: 'accept'|'decline', coachId }
    decision: (b) => call('POST', '/v1/provider/decision', b),
    // Naledi confirms: { transactionId, practitionerId, needType, providerId, note }
    confirm: (b) => call('POST', '/v1/confirm', b),
    // WeHelp marks the support delivered: { transactionId }
    complete: (b) => call('POST', '/v1/provider/complete', b),
    reset: () => call('POST', '/v1/admin/reset'),
  };
}

// ---------------------------------------------------------------------------
// A ready-made matching rule
// ---------------------------------------------------------------------------
//
// orgProfile is the organisation profile from the demo API:
//   { about: { name, description, base }, capabilities: [{ area }],
//     coverage: { communities: 'Alexandra', tiers: ['Pre-Bronze', 'Bronze'] } }
// Returns the array `match` must return: one entry when the practitioner
// matches (with the reasons to show WeHelp), otherwise [].

function matchOrgProfile(query, orgProfile, opts = {}) {
  const maxChildren = opts.maxChildren === undefined ? 50 : opts.maxChildren;
  const providerId = opts.providerId || 'provider-wehelp';
  const org = orgProfile || {};
  const coverage = org.coverage || {};
  const reasons = [];

  const area = Object.keys(NEED_AREAS).find((a) => NEED_AREAS[a] === query.needType);
  const capable = !!area && (org.capabilities || []).some((c) => String(c.area).toLowerCase() === area.toLowerCase());
  if (!capable) return [];
  reasons.push(`${area} is one of your support capabilities`);

  const communities = String(coverage.communities || '')
    .toLowerCase()
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const region = String(query.region || '').toLowerCase();
  if (!region || !communities.some((c) => region.includes(c) || c.includes(region))) return [];
  reasons.push('Within your service area');

  if (query.tier) {
    const tiers = (coverage.tiers || []).map((t) => String(t).toLowerCase());
    if (!tiers.includes(String(query.tier).toLowerCase())) return [];
    reasons.push(`${query.tier} is an eligible segment`);
  }

  if (query.children !== null && query.children !== undefined && maxChildren !== null && !(Number(query.children) < maxChildren)) return [];

  return [
    {
      providerId,
      name: (org.about && org.about.name) || providerId,
      kind: 'NGO',
      description: (org.about && org.about.description) || '',
      region: communities[0] ? communities[0].replace(/^./, (c) => c.toUpperCase()) : (org.about && org.about.base) || '',
      reasons,
    },
  ];
}

module.exports = { networkRouter, networkClient, matchOrgProfile, NEED_AREAS };
