// match.js -- a provider's own rule for "can we help with this request?".
// Ported from Elevate's coordination-service lib/network-kit.js matchOrgProfile
// (the rule WeHelp's profile is already written for), so each provider node
// decides exactly as Elevate would from the same org profile:
//   1. one of its capability areas maps to the need type;
//   2. the request's region contains one of its communities (or the reverse);
//   3. if a tier is given, it is one of its tiers.
// The children < 50 rule is left out: Naledi's request does not carry it.

'use strict';

function matchProfile({ needType, region, tier }, profile, needAreas) {
  const org = profile || {};
  const coverage = org.coverage || {};
  const reasons = [];

  const area = Object.keys(needAreas).find((a) => needAreas[a] === needType);
  const capable = !!area && (org.capabilities || []).some((c) => String(c.area).toLowerCase() === area.toLowerCase());
  if (!capable) return { match: false, reasons: [`does not cover ${needType}`] };
  reasons.push(`Offers ${area.toLowerCase()} support`);

  const communities = String(coverage.communities || '').toLowerCase().split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  const r = String(region || '').toLowerCase();
  const where = communities.find((c) => r && (r.includes(c) || c.includes(r)));
  if (!where) return { match: false, reasons: [`does not serve ${region || 'an unknown region'}`] };
  reasons.push(`Serves ${where.replace(/^./, (x) => x.toUpperCase())}`);

  if (tier) {
    const tiers = (coverage.tiers || []).map((t) => String(t).toLowerCase());
    if (!tiers.includes(String(tier).toLowerCase())) return { match: false, reasons: [`not for tier ${tier}`] };
    reasons.push(`${tier} is eligible`);
  }
  return { match: true, reasons };
}

module.exports = { matchProfile };
