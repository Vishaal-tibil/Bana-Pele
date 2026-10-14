#!/usr/bin/env node
// new-node.js -- prepares a new provider node for the ECD network.
//
//   node tools/new-node.js <id> --elevate <provider_id> --offer "<title>" --terms "<terms>" [--name "<name>"]
//   e.g. node tools/new-node.js smartstart --elevate provider-smartstart \
//          --offer "Business support for early learning programmes" --terms "Free"
//
// It writes config/nodes/<id>.json (next free ports), then runs configure.js,
// which makes the node's keys, its ONIX config and its registry record.
// Nothing in any other node changes: the registry re-reads its file, and the
// Journey node asks every live provider in the registry.
// Then start it:  ./start-node.sh <id>   (or docker compose up -d, see README)

'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const id = args[0];
const opt = (k) => { const i = args.indexOf(`--${k}`); return i > 0 ? args[i + 1] : undefined; };
if (!id || !/^[a-z][a-z0-9-]{1,30}$/.test(id)) { console.error('usage: new-node.js <id: lower-case letters, digits, dashes> --elevate <provider_id> --offer "<title>" --terms "<terms>"'); process.exit(1); }

const dir = path.join(ROOT, 'config/nodes');
const file = path.join(dir, `${id}.json`);
if (fs.existsSync(file)) { console.error(`${file} already exists`); process.exit(1); }

const elevate = opt('elevate');
const profiles = JSON.parse(fs.readFileSync(path.join(ROOT, 'seed/elevate/org_profiles.json'), 'utf8')).profiles;
const org = profiles.find((p) => p.provider_id === elevate);
if (!org) { console.error(`--elevate must be one of: ${profiles.map((p) => p.provider_id).join(', ')}`); process.exit(1); }
if (!opt('offer') || !opt('terms')) { console.error('--offer and --terms are needed'); process.exit(1); }

const nodes = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const next = (k, base) => Math.max(base, ...nodes.map((n) => n.ports[k])) + 1;
const node = {
  id,
  subscriberId: `${id}.ecd.bana-pele`,
  role: 'BPP',
  name: opt('name') || org.name,
  ports: { app: next('app', 7200), onix: next('onix', 8200), redis: next('redis', 6400) },
  provider: { elevateProviderId: elevate, offer: { title: opt('offer'), terms: opt('terms') } },
};
fs.writeFileSync(file, JSON.stringify(node, null, 2) + '\n');
console.log(`wrote config/nodes/${id}.json`);
// Same mode as the network that is already configured (local or docker).
let mode = process.env.ECD_MODE;
try { mode = mode || JSON.parse(fs.readFileSync(path.join(ROOT, '.generated/registry.json'), 'utf8')).mode; } catch { /* first run */ }
execFileSync(process.execPath, [path.join(__dirname, 'configure.js'), '--mode', mode || 'local'], { stdio: 'inherit' });

const pub = JSON.parse(fs.readFileSync(path.join(ROOT, '.generated/registry.json'), 'utf8')).subscribers.find((s) => s.subscriber_id === node.subscriberId);
console.log(`\nRegistry record for the network team to approve (public parts only):\n${JSON.stringify(pub, null, 2)}`);
console.log(`\nNext: ./start-node.sh ${id}   (local)   or   docker compose -f .generated/docker-compose.yml up -d   (Docker)`);
