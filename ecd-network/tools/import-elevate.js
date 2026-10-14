#!/usr/bin/env node
// import-elevate.js -- refreshes seed/elevate/org_profiles.json from a live
// Elevate export (coordination-org_profiles.csv from the export script).
//
//   node tools/import-elevate.js path/to/elevate-data/coordination-org_profiles.csv
//
// Only provider_id, name, contact_email and profile are read. The provider
// nodes read their rules from this file at start-up, so restart them after.

'use strict';
const fs = require('fs');
const path = require('path');

// RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes.
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: import-elevate.js <coordination-org_profiles.csv>'); process.exit(1); }
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const profiles = rows.map((r) => {
    let profile;
    try { profile = JSON.parse(r.profile); } catch { throw new Error(`profile of ${r.provider_id} is not JSON`); }
    if (!profile.about || !Array.isArray(profile.capabilities) || !profile.coverage) throw new Error(`profile of ${r.provider_id} lacks about/capabilities/coverage`);
    return { provider_id: r.provider_id, name: r.name, contact_email: r.contact_email || null, profile };
  });
  if (!profiles.length) throw new Error('no rows');
  const out = path.resolve(__dirname, '../seed/elevate/org_profiles.json');
  fs.writeFileSync(out, JSON.stringify({ source: `Elevate export ${path.basename(file)}, imported ${new Date().toISOString().slice(0, 10)}`, profiles }, null, 2) + '\n');
  console.log(`wrote ${profiles.length} profiles to seed/elevate/org_profiles.json: ${profiles.map((p) => p.provider_id).join(', ')}`);
}

if (require.main === module) { try { main(); } catch (e) { console.error(e.message); process.exit(1); } }
module.exports = { parseCsv };
