'use strict';
// Network monitor: members from our registry, whether each node's app and
// adapter answer, and every Beckn message each node logged, newest first.
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
};
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const short = (id) => String(id || '').replace('.ecd.bana-pele', '');
const yes = (v, a, b) => el('span', { class: `badge ${v ? 'good' : v === null ? '' : 'bad'}` }, v ? a : v === null ? 'n/a' : b);

async function members() {
  const n = await (await fetch('/api/network')).json();
  $('#net').textContent = `${n.networkId} · registry ${n.registryUp ? 'up' : 'down'}`;
  $('#members').replaceChildren(el('div', { class: 'card scroll' }, el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, 'Node'), el('th', {}, 'Role'), el('th', {}, 'In registry'), el('th', {}, 'Adapter'), el('th', {}, 'App'), el('th', { class: 'hide-sm' }, 'Receiver'))),
    el('tbody', {}, n.members.map((m) => el('tr', {},
      el('td', {}, el('strong', {}, m.name), el('div', { class: 'small muted' }, m.subscriberId)),
      el('td', {}, m.type), el('td', {}, el('span', { class: `badge ${m.state === 'live' ? 'good' : 'warn'}` }, m.state)),
      el('td', {}, yes(m.adapterUp, 'up', 'down')), el('td', {}, yes(m.appUp, 'up', 'down')),
      el('td', { class: 'hide-sm' }, el('code', {}, m.url))))))));
}

async function messages() {
  const tx = $('#tx').value.trim();
  const list = await (await fetch(`/api/network/messages${tx ? `?transactionId=${encodeURIComponent(tx)}` : ''}`)).json();
  $('#messages').replaceChildren(list.length ? el('div', { class: 'card' }, el('ul', { class: 'msgs' }, list.map((m) => el('li', {},
    el('span', { class: 'when' }, clock(m.at)),
    el('strong', {}, short(m.node)),
    el('span', { class: 'dir' }, m.direction === 'in' ? '← from' : '→ to'),
    el('span', {}, short(m.from || m.to)),
    el('code', {}, m.action),
    el('span', { class: `badge ${m.ack === 'ACK' ? 'good' : 'bad'}` }, m.ack === 'ACK' ? (m.direction === 'in' ? 'checked, ACK' : 'signed, ACK') : (m.ack || 'no answer')),
    el('button', { class: 'small', onclick: () => { $('#tx').value = m.transactionId; tick(); } }, 'this request'),
    m.error ? el('div', { class: 'small error' }, m.error) : null)))) : el('p', { class: 'empty' }, 'No messages yet.'));
}

async function tick() { await Promise.all([members(), messages()]).catch((e) => { $('#messages').replaceChildren(el('p', { class: 'error' }, e.message)); }); }
$('#tx').addEventListener('change', tick);
tick();
setInterval(() => { if (!$('#pause').checked) tick(); }, 3000);
