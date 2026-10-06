// mock-mjourney.js
//
// A stand-in for My Journey's backend, used only to test our side of the
// connection. It implements the two endpoints we call on them:
//
//   GET  /network/match?needType=&region=&practitionerId=&tier=&children=
//   POST /network/events
//   GET  /network/health
//
// plus test controls (no key needed):
//
//   GET  /mock/events     every event received (deduplicated by eventId)
//   POST /mock/reset      forget everything
//   POST /mock/config     { failNext: n, matchDelayMs: ms, down: bool }
//
// The matching rule follows WeHelp's declared profile in the demo script:
// Alexandra, registration/infrastructure and related support, Pre-Bronze or
// Bronze, fewer than 50 children.

'use strict';

const http = require('http');

const PORT = process.env.PORT || 3003;
const KEY = process.env.EVENT_KEY || process.env.API_KEY || 'demo-key-change-me';

const SUPPORTED = ['registration', 'infrastructure', 'learning-skilling', 'health-safety', 'nutrition', 'child-development'];

let events = [];
let seen = new Set();
let attempts = 0;
let config = { failNext: 0, matchDelayMs: 0, down: false };

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname.replace(/\/$/, '');

    // ---- test controls ----
    if (path === '/mock/events' && req.method === 'GET') return json(res, 200, { attempts, events });
    if (path === '/mock/reset' && req.method === 'POST') {
      events = [];
      seen = new Set();
      attempts = 0;
      config = { failNext: 0, matchDelayMs: 0, down: false };
      return json(res, 200, { ok: true });
    }
    if (path === '/mock/config' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          config = { ...config, ...JSON.parse(body || '{}') };
        } catch (e) {
          return json(res, 400, { error: 'invalid JSON' });
        }
        return json(res, 200, config);
      });
      return;
    }

    // ---- the endpoints we call ----
    if (config.down) return json(res, 503, { error: 'mock is down' });
    if (path === '/network/health') return json(res, 200, { ok: true });

    if (req.headers['x-api-key'] !== KEY) return json(res, 401, { error: 'unauthorized' });

    if (path === '/network/match' && req.method === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      const answer = () => {
        const reasons = [];
        const ok =
          SUPPORTED.includes(q.needType) &&
          String(q.region || '').toLowerCase().includes('alexandra') &&
          (!q.tier || ['Pre-Bronze', 'Bronze'].includes(q.tier)) &&
          (q.children === '' || q.children === undefined || Number(q.children) < 50);
        if (ok) {
          reasons.push('Within your service area', `${q.needType} is one of your support capabilities`, 'Eligible tier');
          return json(res, 200, {
            matches: [
              {
                providerId: 'provider-wehelp',
                name: 'WeHelp',
                kind: 'NGO',
                description: 'Registration guidance, DSD submission support and infrastructure help for ELPs in Alexandra.',
                region: 'Alexandra',
                reasons,
              },
            ],
          });
        }
        return json(res, 200, { matches: [] });
      };
      return config.matchDelayMs ? setTimeout(answer, config.matchDelayMs) : answer();
    }

    if (path === '/network/events' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        attempts += 1;
        if (config.failNext > 0) {
          config.failNext -= 1;
          return json(res, 503, { error: 'simulated failure' });
        }
        let evt;
        try {
          evt = JSON.parse(body);
        } catch (e) {
          return json(res, 400, { error: 'invalid JSON' });
        }
        if (!seen.has(evt.eventId)) {
          seen.add(evt.eventId);
          events.push({ ...evt, receivedAt: new Date().toISOString() });
          console.log(`[mock] event ${evt.event} tx=${String(evt.transactionId).slice(0, 8)} status=${evt.status}`);
        } else {
          console.log(`[mock] duplicate ${evt.eventId} ignored`);
        }
        return json(res, 200, { ok: true });
      });
      return;
    }

    return json(res, 404, { error: 'not_found' });
  })
  .listen(PORT, '0.0.0.0', () => console.log(`mock-mjourney listening on ${PORT}`));
