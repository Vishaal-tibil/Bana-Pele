// beckn.js -- builds the Beckn v2.0.0 message bodies the ECD nodes exchange.
// Shapes follow the core v2.0.0 schema the ONIX adapters validate against
// (protocol-specifications-v2, tag core-v2.0.0-lts):
//   discover    message.intent.textSearch
//   on_discover message.catalogs[] (Catalog: id, descriptor, provider, resources, offers)
//   the rest    message.contract (Contract: commitments[] each with status, resources, offer)
// Descriptor allows only code, name, shortDesc, longDesc (and media), so our
// own data (need, region, shared details, order state) rides as JSON text in
// longDesc -- the same approach the current network already uses.
//
// Contract.status.code   : DRAFT | ACTIVE | CANCELLED | COMPLETE
// Commitment.status code : DRAFT | ACTIVE | CLOSED

'use strict';

const json = (v) => JSON.stringify(v);
function parse(text, fallback = {}) { try { return JSON.parse(text); } catch { return fallback; } }

function discoverMessage({ needType, region, tier }) {
  return { intent: { textSearch: json({ needType, region, ...(tier ? { tier } : {}) }) } };
}
function readIntent(message) {
  return parse(message && message.intent && message.intent.textSearch);
}

// One catalog per answering provider, one resource + one offer per offer.
function catalogMessage({ providerId, providerName, description, bppUri, offer, why, needType, region }) {
  return {
    catalogs: [{
      id: `catalog-${providerId}`,
      bppId: providerId,
      bppUri,
      descriptor: { name: providerName, shortDesc: description },
      provider: { id: providerId, descriptor: { name: providerName, shortDesc: description } },
      resources: [{
        id: offer.id,
        descriptor: { name: offer.title, longDesc: json({ terms: offer.terms, why, needType, region }) },
      }],
      offers: [{ id: offer.id, descriptor: { name: offer.title, shortDesc: offer.terms }, resourceIds: [offer.id] }],
    }],
  };
}
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : v === undefined || v === null ? '' : String(v).slice(0, max));
function readCatalogs(message) {
  const list = message && Array.isArray(message.catalogs) ? message.catalogs : [];
  return list.slice(0, 20).map((c) => {
    const r = (c.resources || [])[0] || {};
    const extra = parse(r.descriptor && r.descriptor.longDesc);
    // A provider's catalog is outside data: keep only strings of sane length.
    return {
      providerId: str((c.provider && c.provider.id) || c.bppId),
      providerName: str((c.provider && c.provider.descriptor && c.provider.descriptor.name) || c.bppId, 80),
      description: str(c.provider && c.provider.descriptor && c.provider.descriptor.shortDesc, 300),
      offerId: str(r.id, 100),
      title: str((r.descriptor && r.descriptor.name) || r.id, 120),
      terms: str(extra.terms, 80),
      why: (Array.isArray(extra.why) ? extra.why : []).slice(0, 6).map((w) => str(w, 120)),
    };
  });
}

// contract: what select/init/confirm/status and every on_ answer carry.
//  data   -> descriptor {name: <kind>, longDesc: JSON}  (shared-details | order-state)
//  coach  -> an extra participant with code "coach"
function contractMessage({ id, providerId, providerName, needType, offerId, offerTitle, contractStatus, commitmentStatus, kind, data, coach }) {
  const participants = [{ id: providerId, descriptor: { name: providerName || providerId, code: 'provider' } }];
  if (coach) participants.push({ id: `coach:${coach}`, descriptor: { name: coach, code: 'coach' } });
  return {
    contract: {
      id,
      ...(kind ? { descriptor: { name: kind, longDesc: json(data || {}) } } : {}),
      status: { code: contractStatus },
      participants,
      commitments: [{
        id: `commitment-${id}`,
        status: { descriptor: { code: commitmentStatus || (contractStatus === 'DRAFT' ? 'DRAFT' : contractStatus === 'ACTIVE' ? 'ACTIVE' : 'CLOSED') } },
        resources: [{ id: offerId, descriptor: { name: offerTitle || offerId, code: needType }, quantity: { unitQuantity: 1, unitCode: 'NEED' } }],
        offer: { id: offerId, resourceIds: [offerId] },
      }],
    },
  };
}
function readContract(message) {
  const c = (message && message.contract) || {};
  const cm = (c.commitments || [])[0] || {};
  const res = (cm.resources || [])[0] || {};
  const provider = (c.participants || []).find((p) => p.descriptor && p.descriptor.code === 'provider') || {};
  const coach = (c.participants || []).find((p) => p.descriptor && p.descriptor.code === 'coach');
  return {
    id: c.id,
    status: c.status && c.status.code,
    kind: c.descriptor && c.descriptor.name,
    data: parse(c.descriptor && c.descriptor.longDesc),
    providerId: provider.id,
    offerId: (cm.offer && cm.offer.id) || res.id,
    offerTitle: res.descriptor && res.descriptor.name,
    needType: res.descriptor && res.descriptor.code,
    coach: coach && coach.descriptor && coach.descriptor.name,
  };
}

module.exports = { discoverMessage, readIntent, catalogMessage, readCatalogs, contractMessage, readContract };
