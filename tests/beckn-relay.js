// beckn-relay.js -- a stand-in for onix-bap/onix-bpp, for testing the two apps
// on one machine without Docker. It forwards each Beckn message between them,
// can drop the next message of a given action (to simulate a lost callback),
// and, when the schema tools are installed, checks every message against the
// Beckn 2.0 schema.
//
//   node tests/beckn-relay.js                        (listens on :4100)
//   sandbox-bpp:  ONIX_CALLER=http://localhost:4100/bap
//   sandbox-bap:  BACKBONE_CALLER=http://localhost:4100/bpp
//
// Schema checks (optional): npm install --no-save ajv js-yaml, and
// SPEC=<path to the Beckn 2.0 OpenAPI yaml>. Like onix, "format" is not
// enforced (our contract ids are not UUIDs).
//
//   POST /drop/<action>   drop the next message with that action
//   GET  /report          { seen: {action: count}, invalid: [...], schemaChecks: bool }

'use strict';

const http = require('http');
const fs = require('fs');

const PORT = Number(process.env.RELAY_PORT || 4100);
const BPP = process.env.BPP_WEBHOOK || 'http://localhost:4001/api/webhook';
const BAP = process.env.BAP_WEBHOOK || 'http://localhost:4000/api/bap-webhook';

const validators = {};
if (process.env.SPEC) {
  try {
    const yaml = require('js-yaml');
    const Ajv2020 = require('ajv/dist/2020');
    const spec = yaml.load(fs.readFileSync(process.env.SPEC, 'utf8'));
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
    ajv.addSchema({ $id: 'beckn', components: spec.components });
    for (const [p, ops] of Object.entries(spec.paths)) {
      const s = ops.post && ops.post.requestBody && ops.post.requestBody.content['application/json'].schema;
      if (s) validators[p.slice(1)] = ajv.compile(JSON.parse(JSON.stringify(s).replace(/"#\/components/g, '"beckn#/components')));
    }
  } catch (e) {
    console.log(`schema checks off: ${e.message}`);
  }
}
const schemaChecks = Object.keys(validators).length > 0;

const drops = {};
const seen = {};
const invalid = [];

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/report') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ seen, invalid, schemaChecks }));
      return;
    }
    const m = req.url.match(/^\/(bpp|bap|drop)\/([a-z_]+)$/);
    if (req.method !== 'POST' || !m) { res.writeHead(404); res.end(); return; }
    const action = m[2];
    if (m[1] === 'drop') {
      drops[action] = (drops[action] || 0) + 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ dropping: action }));
      return;
    }
    let msg;
    try { msg = JSON.parse(body); } catch (e) { res.writeHead(400); res.end(); return; }
    seen[action] = (seen[action] || 0) + 1;
    const v = validators[action];
    if (schemaChecks && !v) invalid.push({ action, error: 'no schema for this action' });
    else if (v && !v(msg)) invalid.push({ action, errors: v.errors.slice(0, 5) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: { ack: { status: 'ACK' } } }));
    if (drops[action]) {
      drops[action] -= 1;
      console.log(`dropped ${action} (${msg.context && msg.context.transactionId})`);
      return;
    }
    fetch(`${m[1] === 'bpp' ? BPP : BAP}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      .catch((e) => console.log(`forward failed: ${action}: ${e.message}`));
  });
}).listen(PORT, () => console.log(`beckn-relay on :${PORT}${schemaChecks ? `, checking ${Object.keys(validators).length} schemas` : ''}`));
