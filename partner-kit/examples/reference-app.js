// reference-app.js -- a working example of a partner backend joined to the
// network with the kit. It mimics the shape of the My Journey demo server
// (same endpoint names as openapi.v2.yaml) with just enough behaviour to run
// the whole "script 1" story, and it marks with "NETWORK:" every place the kit
// is used. Copy those places into the real demo server.
//
//   NETWORK_BASE_URL   address of the network's /v1 API   (empty = network off)
//   NETWORK_API_KEY    the shared secret
//
// With either unset, every network call is skipped and the app runs on its own
// local logic -- so wiring this in can never break a demo.

'use strict';

const express = require('express');
const { networkRouter, networkClient, matchOrgProfile } = require('../network-kit');

const PORT = process.env.PORT || 3004;

// NETWORK: one client, created once.
const net = networkClient({ baseUrl: process.env.NETWORK_BASE_URL, apiKey: process.env.NETWORK_API_KEY });

// ---- the demo's own data (stands in for demo-server's in-memory store) ----

const orgProfile = {
  about: { name: 'WeHelp', description: 'Registration guidance, DSD submission support and infrastructure help.', base: 'Johannesburg, Gauteng' },
  capabilities: [
    { area: 'Registration' }, { area: 'Learning & Skilling' }, { area: 'Health & Safety' },
    { area: 'Nutrition' }, { area: 'Infrastructure' }, { area: 'Business / Financial Support' },
  ],
  coverage: { province: 'Gauteng', municipality: 'City of Johannesburg', communities: 'Alexandra', radiusKm: 15, tiers: ['Pre-Bronze', 'Bronze'] },
};

const PROVIDER_ID = 'provider-wehelp';
let store;
function freshStore() {
  return { version: 0, epoch: (store ? store.epoch : 0) + 1, practitioners: {}, notifications: [], offers: {}, cases: {}, log: [] };
}
store = freshStore();
const bump = () => { store.version += 1; };
const note = (m) => store.log.push(`${new Date().toISOString()} ${m}`);
let seq = 0;
const nid = (p) => `${p}_${(++seq).toString(36)}${Date.now().toString(36).slice(-4)}`;

function addNotification(prac, reasons, via) {
  if (store.notifications.some((n) => n.practitionerId === prac.id)) return;
  store.notifications.push({
    id: nid('ntf'), kind: 'new_practitioner_onboarded', practitionerId: prac.id,
    title: `${prac.name} joined the network`, context: `${prac.ecd || ''} · ${prac.area} · ${prac.tier}`,
    helper: 'Matches your service area and support capabilities.', reasons, status: 'New', via, createdAt: new Date().toISOString(),
  });
  note(`notification for ${prac.id} (${via})`);
}

// ---- NETWORK: the two endpoints the network calls on us ----

const networkRoutes = networkRouter({
  apiKey: process.env.NETWORK_API_KEY || 'network-off',
  // "Does WeHelp match this practitioner?" -- our own rules, in our own code.
  match: async (q) => matchOrgProfile(q, orgProfile),
  // Every network event arrives here, once.
  onEvent: async (e) => {
    const prac = store.practitioners[e.practitionerId];
    if (!prac) return;
    note(`event ${e.event} ${e.status || ''}`);
    if (e.event === 'practitioner.matched') {
      addNotification(prac, (e.payload && e.payload.reasons) || [], 'network');
    } else if (e.event === 'offer.received') {
      // Match on the id WE chose when we sent the offer. (Do not use an id from
      // the HTTP response: the event can arrive before that response does.)
      const offer = store.offers[e.payload.offerId];
      if (offer) { offer.visibleToPractitioner = true; offer.deliveredVia = 'network'; }
    } else if (e.event === 'status.changed') {
      const c = Object.values(store.cases).find((x) => x.practitionerId === prac.id && x.transactionId === e.transactionId);
      if (c && e.status === 'reserved') { c.stage = 'In progress'; c.reservedByNetwork = true; }
      if (c && e.status === 'fulfilled') { c.stage = 'Completed'; c.fulfilledByNetwork = true; }
      if (c && e.status === 'rejected') { c.stage = 'Requested'; c.note = 'The request was not accepted by the network'; }
    }
    bump();
  },
});

const app = express();
app.use(express.json());
app.use('/api/v1', networkRoutes); // NETWORK: mounts /api/v1/network/match, /events, /health

const api = express.Router();
app.use('/api/v1', api);

// ---- Naledi signs up (script step 3-4) ----
api.post('/practitioners/signup', async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.phone || !b.language || !b.area) return res.status(400).json({ code: 'INVALID', message: 'name, phone, language and area are required' });
  const id = `prac_${String(b.name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
  const prac = { id, name: b.name, ecd: b.ecdName, area: b.area, tier: b.tier || 'Pre-Bronze', children: Number(b.children) || 0, tx: null };
  store.practitioners[id] = prac;

  // NETWORK: publish her need. The answer for WeHelp arrives later as the
  // "practitioner.matched" event; the transactionId ties everything together.
  const r = await net.search({ practitionerId: id, needType: 'registration', region: prac.area, tier: prac.tier, children: prac.children });
  if (r.ok) {
    prac.tx = r.data.transactionId;
  } else {
    // FALLBACK: network missing or down -> the demo's own local matching.
    const local = matchOrgProfile({ needType: 'registration', region: prac.area, tier: prac.tier, children: prac.children }, orgProfile);
    if (local.length) addNotification(prac, local[0].reasons, 'local');
  }
  bump();
  res.json({ token: `demo-${id}`, actor: { app: 'naledi', practitionerId: id, name: prac.name }, path: r.ok ? 'network' : 'local' });
});

// ---- WeHelp's Coordination Centre queue (script step 4, 9) ----
api.get('/views/ngo/work-items', (req, res) => {
  const items = [
    ...store.notifications.map((n) => ({ id: n.id, kind: 'request', category: 'New Practitioner Onboarded', title: n.title, entity: n.context, explanation: n.helper, status: { label: n.status }, ctaLabel: 'View overview', practitionerId: n.practitionerId, via: n.via })),
    ...Object.values(store.offers).map((o) => ({ id: o.id, kind: 'offer', category: 'Support Offer Sent', title: o.title, status: o.status, ctaLabel: 'View offer', practitionerId: o.practitionerId })),
  ];
  res.json({ version: store.version, data: items });
});

// ---- WeHelp sends an offer (script step 8) ----
api.post('/offers', async (req, res) => {
  const b = req.body || {};
  const prac = store.practitioners[b.practitionerId];
  if (!prac || !b.title || !b.area) return res.status(400).json({ code: 'INVALID', message: 'practitionerId (known), title and area are required' });
  const offer = { id: nid('off'), practitionerId: prac.id, title: b.title, area: b.area, note: b.note || '', sent: new Date().toISOString(), status: { label: 'Awaiting Practitioner Response' }, visibleToPractitioner: false, caseId: null };
  store.offers[offer.id] = offer;

  // NETWORK: hand the offer to the network; it reaches Naledi's side as the
  // "offer.received" event, and only then does Naledi see it.
  // We send our own offer id; the event echoes it back.
  const r = prac.tx ? await net.offer({ transactionId: prac.tx, providerId: PROVIDER_ID, title: offer.title, area: offer.area, note: offer.note, offerId: offer.id }) : { ok: false };
  if (!r.ok) { offer.visibleToPractitioner = true; offer.deliveredVia = 'local'; } // FALLBACK
  bump();
  res.json(offer);
});

// ---- Naledi's Support Offers tab (script step 8 -> 11) ----
api.get('/views/naledi/support-offers', (req, res) => {
  const data = Object.values(store.offers)
    .filter((o) => o.visibleToPractitioner && (!req.query.practitionerId || o.practitionerId === req.query.practitionerId))
    .map((o) => ({ id: o.id, title: o.title, provider: 'WeHelp', providerId: PROVIDER_ID, description: o.note, format: 'Guided support', relatesTo: 'Register Sunshine ECD', deliveredVia: o.deliveredVia }));
  res.json({ version: store.version, data });
});

const offerOr404 = (req, res) => {
  const o = store.offers[req.params.id];
  if (!o) res.status(404).json({ code: 'NOT_FOUND', message: 'no such offer' });
  return o;
};

// ---- Naledi accepts (script step 11) ----
api.post('/offers/:id/accept', async (req, res) => {
  const offer = offerOr404(req, res); if (!offer) return;
  if (offer.caseId) return res.json(offer); // already accepted: safe to repeat
  const prac = store.practitioners[offer.practitionerId];
  const c = { id: nid('case'), practitionerId: prac.id, offerId: offer.id, transactionId: prac.tx, title: offer.title, stage: 'Accepted', needsAssignment: true, coachId: null };
  store.cases[c.id] = c; offer.caseId = c.id; offer.status = { label: 'Accepted' };
  // NETWORK: Naledi's acceptance becomes select + init on the network; WeHelp's
  // side is told with the "request.received" event.
  if (prac.tx) await net.select({ transactionId: prac.tx, practitionerId: prac.id, needType: 'registration', providerId: PROVIDER_ID });
  bump();
  res.json(offer);
});

// ---- WeHelp assigns a coach (script step 11, continued) ----
api.post('/offers/:id/assign', async (req, res) => {
  const offer = offerOr404(req, res); if (!offer) return;
  const c = store.cases[offer.caseId];
  if (!c) return res.status(409).json({ code: 'NOT_ACCEPTED', message: 'the offer has not been accepted yet' });
  const coachId = (req.body || {}).coachId;
  if (!coachId) return res.status(400).json({ code: 'INVALID', message: 'coachId is required' });
  c.coachId = coachId; c.needsAssignment = false; c.stage = 'Assigned';
  // NETWORK: WeHelp's decision. The network confirms with "status.changed".
  const prac = store.practitioners[offer.practitionerId];
  if (prac.tx) await net.decision({ transactionId: prac.tx, decision: 'accept', coachId });
  else c.stage = 'In progress'; // FALLBACK
  bump();
  res.json(c);
});

// ---- Fulfilment (script step 12) ----
api.post('/offers/:id/complete', async (req, res) => {
  const offer = offerOr404(req, res); if (!offer) return;
  const c = store.cases[offer.caseId];
  if (!c) return res.status(409).json({ code: 'NOT_ACCEPTED', message: 'the offer has not been accepted yet' });
  const prac = store.practitioners[offer.practitionerId];
  // NETWORK: Naledi confirms, WeHelp marks it delivered. "status.changed
  // fulfilled" comes back; the local update below happens either way.
  if (prac.tx) {
    await net.confirm({ transactionId: prac.tx, practitionerId: prac.id, needType: 'registration', providerId: PROVIDER_ID, note: 'Documents reviewed' });
    await net.complete({ transactionId: prac.tx });
  }
  c.stage = 'Completed'; offer.status = { label: 'Completed' };
  bump();
  res.json(c);
});

// ---- polling, reset, and a debug view for tests ----
api.get('/changes', (req, res) => res.json({ changed: Number(req.query.since) < store.version, version: store.version, epoch: store.epoch }));
api.post('/admin/reset', async (req, res) => { store = freshStore(); await net.reset(); res.json({ epoch: store.epoch, version: 0 }); });
api.get('/debug/state', (req, res) => res.json({ ...store, networkEnabled: net.enabled }));

app.listen(PORT, '0.0.0.0', () => console.log(`reference partner app on :${PORT} (network ${net.enabled ? 'ON -> ' + process.env.NETWORK_BASE_URL : 'OFF'})`));
