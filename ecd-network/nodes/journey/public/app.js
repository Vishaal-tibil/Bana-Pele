'use strict';
// Naledi app (Front Door). Talks only to its own Journey node.
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v); }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
};
const time = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const STATUS = {
  ASKING: ['Asking providers', 'warn'], ANSWERS_IN: ['Answers in', 'accent'], BOOKING: ['Booking', 'warn'],
  PENDING: ['Waiting for the provider', 'warn'], ACCEPTED: ['Accepted', 'good'], DECLINED: ['Declined', 'bad'],
  COMPLETED: ['Completed', 'good'], FAILED: ['Something went wrong', 'bad'], NO_ANSWER: ['No answers', 'bad'],
};
let options, requests = [], picking = null, busy = false;

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status });
  return j;
}

function requestCard(r) {
  const [label, tone] = STATUS[r.status] || [r.status, ''];
  const card = el('article', { class: 'card', 'data-request': r.id },
    el('div', { class: 'row' },
      el('div', { class: 'grow' }, el('h3', {}, r.needLabel), el('div', { class: 'muted small' }, `${r.region} · asked ${time(r.createdAt)}`)),
      el('span', { class: `badge ${tone}` }, label)));

  const canChoose = !r.chosen || ['FAILED', 'DECLINED'].includes(r.status);
  if (r.chosen) {
    card.append(el('p', { class: 'small mt' }, `Provider: ${r.chosen.providerName}, ${r.chosen.title}`));
    if (r.order && r.order.coach) card.append(el('p', { class: 'small' }, `Your coach: ${r.order.coach}`));
    if (r.order && !canChoose) card.append(el('div', { class: 'row' }, el('button', { onclick: (e) => act(e, () => api(`/api/requests/${r.id}/refresh`, {})) }, 'Check for updates')));
  }
  const others = r.answers.filter((a) => !r.chosen || a.providerId !== r.chosen.providerId);
  if (canChoose) {
    if (r.chosen && others.length) card.append(el('p', { class: 'small mt' }, 'You can choose another provider:'));
    if (!r.chosen && r.answers.length) {
      card.append(el('p', { class: 'small mt' }, `${r.answers.length} provider${r.answers.length === 1 ? '' : 's'} can help. Best match first:`));
    } else if (!r.chosen && r.status === 'ASKING') {
      card.append(el('p', { class: 'muted small mt' }, `Asked ${r.asked.length} providers. Answers appear here as they come in; providers that cannot help do not answer.`));
    }
    for (const a of others) card.append(answerBlock(r, a));
  }
  card.append(el('ol', { class: 'timeline' }, r.timeline.slice().reverse().map((t) => el('li', {}, t.text, el('time', {}, time(t.at))))));
  card.append(el('div', { class: 'error', role: 'alert' }));
  return card;
}

function answerBlock(r, a) {
  const open = picking && picking.req === r.id && picking.offer === a.offerId;
  const box = el('div', { class: `card${open ? ' pick' : ''}`, 'data-offer': a.offerId },
    el('div', { class: 'row' },
      el('div', { class: 'grow' }, el('strong', {}, `${a.rank}. ${a.providerName}`), el('div', { class: 'small' }, `${a.title} · ${a.terms}`)),
      open ? null : el('button', { class: 'primary', onclick: () => { picking = { req: r.id, offer: a.offerId }; render(); } }, 'Choose')),
    a.description ? el('p', { class: 'muted small' }, a.description) : null,
    el('ul', { class: 'plain small' }, a.why.map((w) => el('li', {}, `✓ ${w}`))));
  if (open) {
    const checks = options.share.map((f) => el('label', { class: 'check' }, el('input', { type: 'checkbox', value: f.field, checked: f.field !== 'centre' ? 'checked' : null }), f.label));
    box.append(
      el('p', { class: 'small mt' }, `What may ${a.providerName} see? Nothing else leaves the Journey Platform, and no other provider gets any of it.`),
      ...checks,
      el('div', { class: 'row mt' },
        el('button', { class: 'primary', onclick: (e) => act(e, () => api(`/api/requests/${r.id}/accept`, { offerId: a.offerId, share: checks.map((c) => c.querySelector('input')).filter((i) => i.checked).map((i) => i.value) }).then(() => { picking = null; })) }, 'Share and book'),
        el('button', { onclick: () => { picking = null; render(); } }, 'Cancel')));
  }
  return box;
}

async function act(e, fn) {
  if (busy) return; busy = true;
  const err = e.target.closest('article').querySelector('.error'); err.textContent = '';
  e.target.disabled = true;
  try { await fn(); await load(); } catch (x) { err.textContent = x.message; } finally { busy = false; e.target.disabled = false; }
}

function render() {
  $('#requests').replaceChildren(...(requests.length ? requests.map(requestCard) : [el('p', { class: 'empty' }, 'No requests yet.')]));
}

async function load() { requests = await api('/api/requests'); render(); }

async function showHome(me) {
  $('#register').hidden = true; $('#home').hidden = false;
  $('#who').textContent = `${me.name} · ${me.region}`;
  await load();
  setInterval(() => { if (!busy && !picking) load().catch(() => {}); }, 2000);
}

(async () => {
  options = await api('/api/options');
  $('#need').replaceChildren(...options.needs.map((n) => el('option', { value: n.value }, n.label)));
  $('#r-region').replaceChildren(...options.regions.map((r) => el('option', { value: r }, r)));
  const who = await api('/api/me');
  if (who.registered) return showHome(who);
  $('#register').hidden = false;
  $('#demo').addEventListener('click', () => {
    const d = options.demo; $('#r-name').value = d.name; $('#r-centre').value = d.centre; $('#r-phone').value = d.phone; $('#r-region').value = 'Alexandra, Gauteng';
  });
  $('#reg-form').addEventListener('submit', async (e) => {
    e.preventDefault(); $('#reg-error').textContent = '';
    const f = new FormData(e.target);
    try { await showHome(await api('/api/naledis', Object.fromEntries(f.entries()))); } catch (x) { $('#reg-error').textContent = x.message; }
  });
  $('#ask').addEventListener('click', async () => {
    $('#ask-error').textContent = '';
    try { await api('/api/requests', { needType: $('#need').value }); await load(); } catch (x) { $('#ask-error').textContent = x.message; }
  });
})().catch((e) => { document.querySelector('main').append(el('p', { class: 'error' }, `Could not load: ${e.message}`)); });
