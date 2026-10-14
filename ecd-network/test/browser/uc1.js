#!/usr/bin/env node
// browser/uc1.js -- UC1 by clicking through the real pages, like a person would:
// Naledi registers and asks, picks WeHelp and ticks what to share; WeHelp's staff
// accept with a coach and complete; Naledi sees each step. Saves screenshots.
//
//   npm i playwright (anywhere on NODE_PATH)   CHROMIUM=/path/to/chrome   node test/browser/uc1.js [outdir]

'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const port = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, `config/nodes/${id}.json`), 'utf8')).ports.app;
const OUT = process.argv[2] || path.join(ROOT, '.run/screens');
fs.mkdirSync(OUT, { recursive: true });

let failed = 0, passed = 0;
const check = (name, ok, detail) => { if (ok) { passed++; console.log(`  ok    ${name}`); } else { failed++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); } };

(async () => {
  console.log('UC1 in a real browser');
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const errors = [];
  const watch = (p) => { p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => m.type() === 'error' && errors.push(m.text())); };
  const naledi = await browser.newPage({ viewport: { width: 390, height: 844 } }); watch(naledi);
  const staff = await browser.newPage({ viewport: { width: 1200, height: 800 } }); watch(staff);
  const J = `http://127.0.0.1:${port('journey')}`, W = `http://127.0.0.1:${port('wehelp')}`;

  await naledi.goto(J);
  await naledi.click('#demo');
  await naledi.click('#reg-form button[type=submit]');
  await naledi.waitForSelector('#home:not([hidden])');
  check('Naledi registers with the demo practitioner', (await naledi.textContent('#who')).includes('Naledi M'));

  await naledi.selectOption('#need', 'registration');
  await naledi.click('#ask');
  await naledi.waitForSelector('[data-offer]', { timeout: 15000 });
  await naledi.screenshot({ path: path.join(OUT, '1-answers-phone.png'), fullPage: true });
  const offers = await naledi.$$eval('[data-offer] strong', (n) => n.map((x) => x.textContent));
  check('WeHelp answers; GROW stays silent', offers.length === 1 && offers[0].includes('WeHelp'), JSON.stringify(offers));

  await naledi.click('[data-offer] button.primary');
  const boxes = await naledi.$$('[data-offer] input[type=checkbox]');
  check('consent step lists what she can share', boxes.length === 3);
  await naledi.screenshot({ path: path.join(OUT, '2-consent-phone.png'), fullPage: true });
  await naledi.click('text=Share and book');
  await naledi.waitForSelector('text=Waiting for the provider', { timeout: 15000 });
  check('booking goes through select, init and confirm: waiting for WeHelp', true);

  await staff.goto(W);
  await staff.waitForSelector('article input[list=coaches]');
  const shared = await staff.textContent('article');
  check('WeHelp sees name and phone, not the centre', shared.includes('name: Naledi M') && shared.includes('phone:') && !shared.includes('Little Stars'), shared);
  await staff.screenshot({ path: path.join(OUT, '3-wehelp-new.png'), fullPage: true });
  await staff.fill('article input[list=coaches]', 'Thabo Nkosi');
  await staff.click('article button.primary');
  await naledi.waitForSelector('text=Your coach: Thabo Nkosi', { timeout: 15000 });
  check('Naledi sees WeHelp accepted, with her coach', true);

  await staff.click('button[data-tab=progress]');
  await staff.click('text=Mark support delivered');
  await naledi.waitForSelector('article .badge.good:has-text("Completed")', { timeout: 15000 });
  check('Naledi sees the support completed', true);
  await naledi.screenshot({ path: path.join(OUT, '4-completed-phone.png'), fullPage: true });

  const mon = await browser.newPage({ viewport: { width: 1200, height: 900 }, colorScheme: 'dark' }); watch(mon);
  await mon.goto(`${J}/monitor`);
  await mon.waitForSelector('ul.msgs li');
  const rows = await mon.$$eval('ul.msgs li', (n) => n.map((x) => x.textContent));
  check('monitor shows the signed messages across nodes', rows.some((r) => r.includes('on_status')) && rows.some((r) => r.includes('init')));
  const upCount = await mon.$$eval('#members .badge.good', (n) => n.length);
  check('monitor shows every member live with app and adapter up', upCount >= 9, `${upCount} green badges`);
  await mon.screenshot({ path: path.join(OUT, '5-monitor-dark.png'), fullPage: true });

  check('no errors in any page', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed   (screenshots in ${OUT})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
