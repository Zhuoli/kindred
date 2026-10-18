const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const form = $('#plan-form');
const statusEl = $('#status');
const resultEl = $('#result');
const checkCard = $('#check');
const checkForm = $('#check-form');
const checkResult = $('#check-result');
const live = $('#live');
const liveBody = $('#live-body');
const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//.test(u) ? u : '');
const pct = (x) => (x == null ? '' : `${Math.round(x * 100)}`);
const titleFor = (occasion) => { const o = String(occasion || 'just because'); return `${/^[aeiou]/i.test(o) ? 'An' : 'A'} ${o}`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastRequest = null;
let busy = false;

// ---- Mode switch ----
const mode = () => form.elements.mode.value;
function applyMode() {
  const us = mode() === 'us';
  $$('[data-us-only]').forEach((el) => { el.hidden = !us; });
  form.classList.toggle('is-us', us);
  $('.go', form).textContent = us ? 'Plan it for both of us' : 'Plan it';
  if (us && !form.elements.yourLoves.value.trim()) form.elements.yourLoves.value = 'The Bear\nWes Anderson\nRadiohead';
}
$$('input[name="mode"]', form).forEach((r) => r.addEventListener('change', applyMode));

// ---- Example friends (pre-built plans live in Kindred's private cache) ----
async function loadExamples() {
  try {
    const res = await fetch('/api/examples');
    const { examples } = await res.json();
    $('#examples').innerHTML = examples.map((e) => `
      <button type="button" class="ex ${e.mode === 'us' ? 'ex-us' : ''}" data-id="${esc(e.id)}">
        <span class="ex-mode">${e.mode === 'us' ? 'For both of us' : 'For them'}</span>
        <b>${esc(e.title)}</b><span>${esc(e.blurb)}</span>
        <small>${esc(e.input.friend)}${e.mode === 'us' ? ` + ${esc(e.input.you)}` : ''} · ${esc(e.input.city)}</small>
      </button>`).join('');
    $$('.ex').forEach((b) => b.addEventListener('click', () => {
      const ex = examples.find((x) => x.id === b.dataset.id);
      fillForm(ex.input);
      submitPlan(ex.input);
    }));
  } catch { $('.examples-card').hidden = true; }
}

function fillForm(input) {
  const f = form.elements;
  f.mode.value = input.mode === 'us' ? 'us' : 'gift';
  f.friend.value = input.friend ?? '';
  f.occasion.value = input.occasion ?? '';
  f.loves.value = (input.loves ?? []).join('\n');
  f.interests.value = (input.interests ?? []).join(', ');
  f.you.value = input.you ?? '';
  f.yourLoves.value = (input.yourLoves ?? []).join('\n');
  f.yourInterests.value = (input.yourInterests ?? []).join(', ');
  f.city.value = input.city ?? '';
  f.vibe.value = input.vibe ?? 'dinner';
  f.budget.value = String(input.budget ?? 3);
  f.surprise.checked = Boolean(input.surprise);
  applyMode();
}

const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const commas = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
function readForm() {
  const f = form.elements;
  const body = {
    friend: f.friend.value, occasion: f.occasion.value,
    loves: lines(f.loves.value), interests: commas(f.interests.value),
    city: f.city.value, vibe: f.vibe.value, budget: Number(f.budget.value), surprise: f.surprise.checked,
  };
  if (mode() === 'us') Object.assign(body, { mode: 'us', you: f.you.value, yourLoves: lines(f.yourLoves.value), yourInterests: commas(f.yourInterests.value) });
  return body;
}

// ---- Live agent view ----
const PHASES = {
  resolve: 'Matching their loves to Qloo entities and tags',
  fingerprint: 'Reading the taste fingerprint',
  compare: 'Comparing the two tastes',
  plan: 'Querying Qloo in parallel and vetting every result',
  compose: 'Explaining each pick',
};
const phaseOf = (step) => {
  if (/^(resolve|interest)/.test(step)) return 'resolve';
  if (/fingerprint/.test(step)) return 'fingerprint';
  if (/common ground/.test(step)) return 'compare';
  return 'plan';
};

function liveView() {
  let group = null;
  const rows = new Map();
  let calls = 0;
  let started = performance.now();
  let timer = null;
  const meta = $('#live-meta');
  const tick = () => { meta.textContent = `${calls} Qloo call${calls === 1 ? '' : 's'} · ${((performance.now() - started) / 1000).toFixed(1)}s`; };
  return {
    reset(title) {
      liveBody.innerHTML = '';
      group = null; rows.clear(); calls = 0; started = performance.now();
      $('#live-title').textContent = title;
      live.hidden = false;
      live.classList.add('running');
      live.classList.remove('collapsed');
      $('#live-toggle').hidden = true;
      clearInterval(timer); timer = setInterval(tick, 100); tick();
    },
    phase(name, label) {
      group = document.createElement('div');
      group.className = 'phase active';
      group.dataset.phase = name;
      group.innerHTML = `<p class="phase-h">${esc(label || PHASES[name] || name)}</p><ol></ol>`;
      $$('.phase.active', liveBody).forEach((g) => g.classList.remove('active'));
      liveBody.appendChild(group);
    },
    start(ev) {
      if (!group) this.phase(phaseOf(ev.step));
      const li = document.createElement('li');
      li.className = 'call pending';
      li.innerHTML = `<span class="st" aria-hidden="true"></span><span class="nm">${esc(ev.step)}</span> <code>${esc(ev.endpoint)}</code><span class="res">querying…</span>`;
      $('ol', group).appendChild(li);
      rows.set(ev.id, li);
      calls += 1;
    },
    step(ev) {
      let li = rows.get(ev.id);
      if (!li) { this.start(ev); li = rows.get(ev.id); }
      li.className = `call ${ev.error ? 'failed' : 'done'}`;
      const kept = ev.kept != null ? ` · kept <b>${ev.kept}</b>` : '';
      li.querySelector('.res').innerHTML = ev.error
        ? `<span class="err">${esc(ev.error)}</span>`
        : `${ev.count} result${ev.count === 1 ? '' : 's'}${kept} · ${ev.ms}ms${ev.note ? ` · <i>${esc(ev.note)}</i>` : ''}`;
      const extra = [];
      if (ev.dropped?.length) extra.push(`<span class="dropped">Vetted out: ${ev.dropped.map(esc).join(' · ')}</span>`);
      if (ev.params) extra.push(`<code class="params">${esc(Object.entries(ev.params).map(([k, v]) => `${k}=${v}`).join('&'))}</code>`);
      if (extra.length) li.insertAdjacentHTML('beforeend', `<div class="more">${extra.join('')}</div>`);
    },
    async replay(trace) {
      // Cached plans have no live run; replay the recorded steps quickly so the work stays visible.
      let cur = null;
      for (const [i, t] of trace.entries()) {
        const ph = phaseOf(t.step);
        if (ph !== cur) { cur = ph; this.phase(ph); }
        this.start({ id: `r${i}`, step: t.step, endpoint: t.endpoint });
        this.step({ id: `r${i}`, ...t });
        if (!reduceMotion) await sleep(trace.length > 20 ? 25 : 45);
      }
    },
    finish(text) {
      clearInterval(timer);
      tick();
      if (text) meta.textContent = text;
      live.classList.remove('running');
      $$('.phase.active', liveBody).forEach((g) => g.classList.remove('active'));
      $('#live-toggle').hidden = false;
    },
  };
}
const lv = liveView();
$('#show-params').addEventListener('change', (e) => live.classList.toggle('show-params', e.target.checked));
$('#live-toggle').addEventListener('click', () => {
  const c = live.classList.toggle('collapsed');
  $('#live-toggle').textContent = c ? 'Show steps' : 'Hide steps';
});

async function postStream(url, body, onEvent) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(body) });
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('ndjson') || !res.body?.getReader) {
    const data = await res.json();
    if (data?.type === 'result') return data;
    return { status: res.status, result: data };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let final = null;
  const handle = (line) => {
    if (!line.trim()) return;
    const ev = JSON.parse(line);
    if (ev.type === 'result') final = ev; else onEvent(ev);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
  handle(buf);
  return final ?? { status: 500, result: { ok: false, error: 'The connection closed early. Please try again.' } };
}

// ---- Rendering ----
const personName = (plan, who) => (who === 'them' ? plan.friend : who === 'you' ? (plan.you && plan.you !== 'you' ? plan.you : 'you') : 'you both');

function reasons(item, plan) {
  if (plan?.mode === 'us') {
    if (!item.because?.length) return '';
    // Group the loves behind a pick by person: "Maya loves X and Y, and you love Z".
    const order = ['both', 'them', 'you'];
    const groups = order.map((who) => [who, item.because.filter((b) => b.who === who).map((b) => `<b>${esc(b.name)}</b>`)]).filter(([, xs]) => xs.length);
    const parts = groups.map(([who, xs]) => {
      const n = personName(plan, who);
      return `${esc(n)} ${who === 'both' || n === 'you' ? 'love' : 'loves'} ${xs.join(' and ')}`;
    });
    return `<p class="why">Because ${parts.join(', and ')}</p>`;
  }
  const parts = [];
  if (item.because?.length) parts.push(`they love ${item.because.map((b) => `<b>${esc(b.name)}</b>`).join(' and ')}`);
  if (item.into?.length) parts.push(`they're into <b>${item.into.map(esc).join(', ')}</b>`);
  return parts.length ? `<p class="why">Because ${parts.join(', and ')}</p>` : '';
}

function leanBadge(item, plan) {
  if (plan?.mode !== 'us' || !item.lean) return '';
  const label = item.lean === 'both' ? 'For both of you' : item.lean === 'unknown' ? 'Blended pick' : `Leans ${personName(plan, item.lean)}`;
  const share = item.share != null ? Math.round(item.share * 100) : 50;
  return `<div class="lean lean-${esc(item.lean)}" title="${esc(personName(plan, 'them'))} ${share}% · ${esc(personName(plan, 'you'))} ${100 - share}%">
    <span class="lean-label">${esc(label)}</span>
    <span class="split" aria-label="${esc(personName(plan, 'them'))} ${share} percent, ${esc(personName(plan, 'you'))} ${100 - share} percent"><span class="a" style="width:${share}%"></span><span class="b" style="width:${100 - share}%"></span></span>
  </div>`;
}

function itemCard(item, plan) {
  const img = safeUrl(item.image);
  const price = item.priceLevel ? ' · ' + '$'.repeat(item.priceLevel) : '';
  const kind = item.kind || item.type;
  const site = safeUrl(item.website);
  return `<article class="item">
    ${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : `<div class="ph" aria-hidden="true">${esc((item.name || '?').slice(0, 1))}</div>`}
    <div class="item-body">
      <h4>${site ? `<a href="${esc(site)}" rel="noopener nofollow" target="_blank">${esc(item.name)}</a>` : esc(item.name)}</h4>
      <p class="meta">${esc(kind)}${item.address ? ' · ' + esc(item.address) : ''}${price}</p>
      ${leanBadge(item, plan)}
      ${item.idea ? `<p class="idea">${esc(item.idea)}</p>` : ''}
      ${item.description ? `<p class="desc">${esc(item.description)}</p>` : ''}
      ${reasons(item, plan)}
      ${item.sharedTags?.length ? `<p class="tags">${item.sharedTags.map((t) => `<span>${esc(t)}</span>`).join('')}</p>` : ''}
    </div>
  </article>`;
}

function section(title, sub, items, plan, icon = '') {
  if (!items?.length) return '';
  return `<section class="card pick-card"><h3>${icon ? `<span class="ic" aria-hidden="true">${icon}</span>` : ''}${esc(title)}</h3>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}${items.map((i) => itemCard(i, plan)).join('')}</section>`;
}

function cacheBadge(plan) {
  if (plan.cache?.hit) return `<p class="badge">⚡ ${plan.example ? 'Pre-built example' : 'Served from Kindred\'s private cache'}: 0 new Qloo calls (saved ${plan.cache.savedCalls}).</p>`;
  return '';
}

const readList = (loved = [], interests = []) => [
  ...loved.map((l) => `<b>${esc(l.name)}</b> <span class="pill">${esc(l.type)}</span>`),
  ...interests.map((i) => `<b>${esc(i.input)}</b> <span class="pill">interest</span>`),
].join(', ');

function warnings(plan) {
  return plan.warnings?.length ? `<ul class="warn">${plan.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '';
}

function renderGift(plan) {
  const g = plan.gifts ?? {};
  const o = plan.outing ?? {};
  return `
    <section class="card summary">
      <h2>${esc(titleFor(plan.occasion))} plan for ${esc(plan.friend)}</h2>
      <p>Kindred read ${readList(plan.loved, plan.interests)}.</p>
      ${plan.profile?.length ? `<p class="fp">Taste fingerprint: ${plan.profile.map((t) => `<span>${esc(t.name)}</span>`).join('')}</p>` : ''}
      ${cacheBadge(plan)}
      ${warnings(plan)}
    </section>
    <div class="grid">
      ${section('Gift: a brand they would actually use', 'Giftable categories only; mass-market names skipped', g.brands, plan, '🎁')}
      ${section('Gift: a book to wrap', null, g.books, plan, '📖')}
      ${section('Gift: an artist to discover', null, g.artists, plan, '🎧')}
      ${o.main?.picks?.length ? section(`Outing in ${o.city}: ${o.main.label}`, `${o.label} · independent spots, checked for venue type and hours`, o.main.picks, plan, '📍') : ''}
      ${o.after?.picks?.length ? section(`Then: ${o.after.label}`, null, o.after.picks, plan, '🌙') : ''}
    </div>`;
}

function renderUs(plan) {
  const t = plan.together ?? {};
  const o = plan.outing ?? {};
  const c = plan.common ?? {};
  const A = personName(plan, 'them');
  const B = personName(plan, 'you');
  const b = plan.balance ?? { both: 0, them: 0, you: 0 };
  const chips = (xs) => (xs?.length ? xs.map((x) => `<span>${esc(x.name ?? x)}</span>`).join('') : '<em>nothing stood out</em>');
  return `
    <section class="card summary">
      <h2>${esc(titleFor(plan.occasion))} plan for ${esc(A)} and ${esc(B)}</h2>
      <p><span class="dot them"></span> ${esc(A)}: ${readList(plan.loved?.them, plan.interests?.them)}</p>
      <p><span class="dot you"></span> ${esc(B === 'you' ? 'You' : B)}: ${readList(plan.loved?.you, plan.interests?.you)}</p>
      <div class="venn" aria-label="Common ground from Qloo's taste comparison">
        <div class="v v-a"><h4>Only ${esc(A)}</h4><p class="fp">${chips(c.them)}</p></div>
        <div class="v v-both"><h4>Common ground</h4><p class="fp">${chips(c.shared)}</p>${c.loves?.length ? `<p class="sub">You both love ${c.loves.map((n) => `<b>${esc(n)}</b>`).join(', ')}</p>` : ''}</div>
        <div class="v v-b"><h4>Only ${esc(B)}</h4><p class="fp">${chips(c.you)}</p></div>
      </div>
      <p class="fair"><b>${b.both}</b> picks serve you both · <b>${b.them}</b> lean ${esc(A)} · <b>${b.you}</b> lean ${esc(B)}. Kindred ranks picks that serve both first and never lets one person take over the plan.</p>
      ${cacheBadge(plan)}
      ${warnings(plan)}
    </section>
    <div class="grid">
      ${o.main?.picks?.length ? section(`Out in ${o.city}: ${o.main.label}`, `${o.label} · chosen from both tastes, vetted for venue type and hours`, o.main.picks, plan, '📍') : ''}
      ${o.after?.picks?.length ? section(`Then: ${o.after.label}`, null, o.after.picks, plan, '🌙') : ''}
      ${section('Watch together: a film', null, t.films, plan, '🎬')}
      ${section('Start a show together', null, t.shows, plan, '📺')}
      ${section('Listen together', null, t.artists, plan, '🎧')}
    </div>`;
}

// Swap broken remote images for the lettered placeholder.
function guardImages(root) {
  $$('img', root).forEach((img) => img.addEventListener('error', () => {
    const ph = document.createElement('div');
    ph.className = 'ph';
    ph.setAttribute('aria-hidden', 'true');
    ph.textContent = (img.closest('.item')?.querySelector('h4')?.textContent || '?').trim().slice(0, 1);
    img.replaceWith(ph);
  }, { once: true }));
}

function render(plan) {
  resultEl.innerHTML = plan.mode === 'us' ? renderUs(plan) : renderGift(plan);
  guardImages(resultEl);
  resultEl.hidden = false;
  checkCard.hidden = plan.mode === 'us';
  checkResult.innerHTML = '';
}

async function submitPlan(body) {
  if (busy) return;
  busy = true;
  const btn = $('.go', form);
  btn.disabled = true;
  statusEl.textContent = '';
  resultEl.hidden = true;
  checkCard.hidden = true;
  lv.reset(body.mode === 'us' ? `Planning for ${body.friend || 'your friend'} and ${body.you || 'you'}` : `Planning for ${body.friend || 'your friend'}`);
  live.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  try {
    const out = await postStream('/api/plan', body, (ev) => {
      if (ev.type === 'phase') lv.phase(ev.phase, ev.label);
      else if (ev.type === 'start') lv.start(ev);
      else if (ev.type === 'step') lv.step(ev);
    });
    const plan = out.result ?? {};
    if (!plan.ok) {
      lv.finish('Stopped');
      statusEl.textContent = plan.error || 'Something went wrong.';
      if (!liveBody.children.length) live.hidden = true;
      return;
    }
    if (plan.cache?.hit && plan.trace?.length) {
      $('#live-title').textContent = plan.example ? 'Replaying how the agent built this example' : 'Replaying the agent\'s steps from cache';
      await lv.replay(plan.trace);
      lv.finish(`${plan.trace.length} Qloo calls recorded · replayed, 0 new calls`);
    } else {
      lv.finish(`${plan.trace?.length ?? 0} Qloo calls · ${((plan.ms ?? 0) / 1000).toFixed(1)}s`);
    }
    $('#live-title').textContent = 'How the agent worked it out';
    lastRequest = body;
    render(plan);
    resultEl.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  } catch {
    lv.finish('Network error');
    statusEl.textContent = 'Network error. Please try again.';
  } finally {
    btn.disabled = false;
    busy = false;
  }
}

form.addEventListener('submit', (e) => { e.preventDefault(); submitPlan(readForm()); });

// ---- Would they like it? ----
function traceList(trace) {
  return `<ol>${trace.map((t) => `<li><b>${esc(t.step)}</b> → <code>${esc(t.endpoint)}</code> · ${t.count} results${t.kept != null ? ` · kept ${t.kept}` : ''} · ${t.ms}ms${t.error ? ` · <span class="err">${esc(t.error)}</span>` : ''}</li>`).join('')}</ol>`;
}

function renderCheck(r) {
  if (!r.ok) { checkResult.innerHTML = `<p class="warn">${esc(r.error || 'Something went wrong.')}</p>`; return; }
  const c = r.candidate ?? {};
  const linkWord = r.verdict.level === 'poor' || r.verdict.level === 'meh' ? 'Closest link to their taste' : 'Because they love';
  checkResult.innerHTML = `
    <div class="verdict v-${esc(r.verdict.level)}">
      <div class="score" aria-label="Taste affinity">${r.affinity != null ? `${pct(r.affinity)}<small>/100</small>` : '★'}</div>
      <div>
        <h4>${esc(c.name)} <span class="pill">${esc(c.kind || c.type)}</span></h4>
        <p class="vlabel">${esc(r.verdict.label)}${r.verdict.note ? ` · ${esc(r.verdict.note)}` : ''}</p>
        ${r.because?.length ? `<p class="why">${linkWord}: ${r.because.map((b) => `<b>${esc(b.name)}</b>`).join(' and ')}</p>` : ''}
        ${r.affinity != null ? `<div class="bar"><span style="width:${pct(r.affinity)}%"></span></div>` : ''}
      </div>
    </div>
    ${r.alternatives?.length ? `<p class="sub">Stronger fits in the same category:</p>${r.alternatives.map((i) => itemCard(i)).join('')}` : ''}
    ${r.cache?.hit ? '<p class="badge">⚡ From cache: 0 new Qloo calls.</p>' : ''}
    <details class="trace-mini"><summary>${r.trace.length} Qloo calls</summary>${traceList(r.trace)}</details>`;
}

checkForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const candidate = checkForm.elements.candidate.value.trim();
  if (!candidate || !lastRequest) return;
  const btn = $('button', checkForm);
  btn.disabled = true;
  checkResult.innerHTML = '<p class="status">Scoring it against their taste…</p>';
  try {
    const { loves: l, interests, city, friend } = lastRequest;
    const res = await fetch('/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ friend, loves: l, interests, city, candidate }) });
    renderCheck(await res.json());
    guardImages(checkResult);
  } catch {
    checkResult.innerHTML = '<p class="warn">Network error. Please try again.</p>';
  } finally {
    btn.disabled = false;
  }
});

applyMode();
loadExamples();
