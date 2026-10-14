'use strict';
// Provider dashboard: what this provider's staff see. Only the details Naledi
// agreed to share ever reach this node, so only those are shown.
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
};
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const NEED = { registration: 'Registration help', infrastructure: 'Infrastructure help', fundraising: 'Business and financial support' };
const STATE = { PENDING: ['New', 'warn'], ACCEPTED: ['Accepted', 'accent'], COMPLETED: ['Completed', 'good'], DECLINED: ['Declined', 'bad'] };
let tab = 'new', profile = null, orders = [], busy = false;

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function renderProfile() {
  $('#title').textContent = `${profile.name} dashboard`;
  document.title = `${profile.name} dashboard`;
  $('#who').textContent = profile.id;
  $('#profile').replaceChildren(
    el('h3', {}, profile.name),
    el('p', { class: 'muted' }, profile.about.description),
    el('div', { class: 'row small' },
      el('span', {}, 'Covers: ', profile.needTypes.map((n) => NEED[n] || n).join(', ')),
      el('span', {}, '· Serves: ', profile.coverage.communities),
      el('span', {}, '· Offer: ', `${profile.offer.title} (${profile.offer.terms})`)),
  );
  $('#coaches').replaceChildren(...profile.coaches.map((c) => el('option', { value: c })));
}

function orderCard(o) {
  const [label, tone] = STATE[o.state];
  const c = o.customer || {};
  const shared = (c.sharedFields || []).map((f) => `${f}: ${c[f]}`);
  const card = el('article', { class: 'card' },
    el('div', { class: 'row' },
      el('div', { class: 'grow' }, el('h3', {}, NEED[o.needType] || o.needType), el('div', { class: 'muted small' }, `${o.id} · ${o.region || 'region not given'} · ${when(o.createdAt)}`)),
      el('span', { class: `badge ${tone}` }, label)),
    el('p', { class: 'small' }, shared.length ? `Shared by the practitioner: ${shared.join(', ')}` : 'The practitioner shared no personal details.'),
    o.coach ? el('p', { class: 'small' }, `Coach: ${o.coach}`) : null,
  );
  const err = el('div', { class: 'error', role: 'alert' });
  const run = async (fn) => { if (busy) return; busy = true; err.textContent = ''; try { await fn(); await load(); } catch (e) { err.textContent = e.message; } finally { busy = false; } };
  if (o.state === 'PENDING') {
    const coach = el('input', { list: 'coaches', placeholder: 'Coach name', 'aria-label': 'Coach name', maxlength: '80' });
    card.append(el('div', { class: 'row' },
      el('div', { class: 'grow' }, coach),
      el('button', { class: 'primary', onclick: () => run(() => { if (!coach.value.trim()) throw new Error('Name the coach first.'); return api(`/api/orders/${o.id}/accept`, { coach: coach.value.trim() }); }) }, 'Accept'),
      el('button', { class: 'danger', onclick: () => run(() => api(`/api/orders/${o.id}/decline`, {})) }, 'Decline')));
  } else if (o.state === 'ACCEPTED') {
    card.append(el('div', { class: 'row' }, el('button', { class: 'primary', onclick: () => run(() => api(`/api/orders/${o.id}/complete`, {})) }, 'Mark support delivered')));
  }
  card.append(err);
  return card;
}

async function render() {
  for (const b of document.querySelectorAll('nav.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  const groups = { new: orders.filter((o) => o.state === 'PENDING'), progress: orders.filter((o) => o.state === 'ACCEPTED'), done: orders.filter((o) => ['COMPLETED', 'DECLINED'].includes(o.state)) };
  for (const k of Object.keys(groups)) $(`#n-${k}`).textContent = groups[k].length ? `(${groups[k].length})` : '';
  const view = $('#view');
  if (groups[tab]) {
    view.replaceChildren(...(groups[tab].length ? groups[tab].map(orderCard) : [el('p', { class: 'empty' }, tab === 'new' ? 'No new orders.' : 'Nothing here yet.')]));
    return;
  }
  if (tab === 'asked') {
    const asked = await api('/api/asked');
    view.replaceChildren(asked.length ? el('div', { class: 'card scroll' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Need'), el('th', {}, 'Region'), el('th', {}, 'Answered'), el('th', { class: 'hide-sm' }, 'Why'))),
      el('tbody', {}, asked.map((a) => el('tr', {}, el('td', {}, when(a.at)), el('td', {}, NEED[a.needType] || a.needType), el('td', {}, a.region || ''),
        el('td', {}, el('span', { class: `badge ${a.answered ? 'good' : ''}` }, a.answered ? 'yes' : 'no')), el('td', { class: 'hide-sm' }, (a.reasons || []).join('; '))))))) : el('p', { class: 'empty' }, 'No requests yet.'));
    return;
  }
  const msgs = await api('/api/messages');
  view.replaceChildren(msgs.length ? el('div', { class: 'card' }, el('ul', { class: 'msgs' }, msgs.map((m) => el('li', {},
    el('span', { class: 'when' }, clock(m.at)),
    el('span', { class: 'dir' }, m.direction === 'in' ? '←' : '→'),
    el('code', {}, m.action),
    el('span', { class: 'peer' }, m.from || m.to || ''),
    el('span', { class: `badge ${m.ack === 'ACK' ? 'good' : 'bad'}` }, m.ack || 'no answer'),
    m.error ? el('div', { class: 'small error' }, m.error) : null)))) : el('p', { class: 'empty' }, 'No messages yet.'));
}

async function load() {
  orders = await api('/api/orders');
  await render();
}

document.querySelector('nav.tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { tab = b.dataset.tab; render(); } });
(async () => {
  profile = await api('/api/profile'); renderProfile(); await load();
  setInterval(() => { if (!busy && !document.activeElement.matches('input')) load().catch(() => {}); }, 3000);
})().catch((e) => { $('#view').replaceChildren(el('p', { class: 'error' }, `Could not load: ${e.message}`)); });
