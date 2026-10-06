const $ = (sel, el = document) => el.querySelector(sel);
const form = $('#plan-form');
const statusEl = $('#status');
const resultEl = $('#result');
const checkCard = $('#check');
const checkForm = $('#check-form');
const checkResult = $('#check-result');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//.test(u) ? u : '');
const pct = (x) => (x == null ? '' : `${Math.round(x * 100)}`);

let lastRequest = null;

// ---- Example friends (pre-built plans live in Kindred's private cache) ----
async function loadExamples() {
  try {
    const res = await fetch('/api/examples');
    const { examples } = await res.json();
    $('#examples').innerHTML = examples.map((e) => `
      <button type="button" class="ex" data-id="${esc(e.id)}">
        <b>${esc(e.title)}</b><span>${esc(e.blurb)}</span>
        <small>${esc(e.input.friend)} · ${esc(e.input.city)}</small>
      </button>`).join('');
    document.querySelectorAll('.ex').forEach((b) => b.addEventListener('click', () => {
      const ex = examples.find((x) => x.id === b.dataset.id);
      fillForm(ex.input);
      submitPlan(ex.input);
    }));
  } catch { $('.examples-card').hidden = true; }
}

function fillForm(input) {
  const f = form.elements;
  f.friend.value = input.friend ?? '';
  f.occasion.value = input.occasion ?? '';
  f.loves.value = (input.loves ?? []).join('\n');
  f.interests.value = (input.interests ?? []).join(', ');
  f.city.value = input.city ?? '';
  f.vibe.value = input.vibe ?? 'dinner';
  f.budget.value = String(input.budget ?? 3);
  f.surprise.checked = Boolean(input.surprise);
}

function readForm() {
  const f = form.elements;
  return {
    friend: f.friend.value, occasion: f.occasion.value,
    loves: f.loves.value.split('\n').map((s) => s.trim()).filter(Boolean),
    interests: f.interests.value.split(',').map((s) => s.trim()).filter(Boolean),
    city: f.city.value, vibe: f.vibe.value, budget: Number(f.budget.value), surprise: f.surprise.checked,
  };
}

// ---- Rendering ----
function reasons(item) {
  const parts = [];
  if (item.because?.length) parts.push(`they love ${item.because.map((b) => `<b>${esc(b.name)}</b>`).join(' and ')}`);
  if (item.into?.length) parts.push(`they're into <b>${item.into.map(esc).join(', ')}</b>`);
  return parts.length ? `<p class="why">Because ${parts.join(', and ')}</p>` : '';
}

function itemCard(item) {
  const img = safeUrl(item.image);
  const price = item.priceLevel ? ' · ' + '$'.repeat(item.priceLevel) : '';
  const kind = item.kind || item.type;
  const site = safeUrl(item.website);
  return `<article class="item">
    ${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<div class="ph" aria-hidden="true"></div>'}
    <div>
      <h4>${site ? `<a href="${esc(site)}" rel="noopener nofollow" target="_blank">${esc(item.name)}</a>` : esc(item.name)}</h4>
      <p class="meta">${esc(kind)}${item.address ? ' · ' + esc(item.address) : ''}${price}</p>
      ${item.idea ? `<p class="idea">${esc(item.idea)}</p>` : ''}
      ${item.description ? `<p class="desc">${esc(item.description)}</p>` : ''}
      ${reasons(item)}
      ${item.sharedTags?.length ? `<p class="tags">${item.sharedTags.map((t) => `<span>${esc(t)}</span>`).join('')}</p>` : ''}
    </div>
  </article>`;
}

function section(title, sub, items) {
  if (!items?.length) return '';
  return `<section class="card"><h3>${esc(title)}</h3>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}${items.map(itemCard).join('')}</section>`;
}

function cacheBadge(plan) {
  if (plan.cache?.hit) return `<p class="badge">⚡ ${plan.example ? 'Pre-built example' : 'Served from Kindred\'s private cache'}: 0 new Qloo calls (saved ${plan.cache.savedCalls}).</p>`;
  return '';
}

function traceList(trace) {
  return `<ol>${trace.map((t) => `<li><b>${esc(t.step)}</b> → <code>${esc(t.endpoint)}</code> · ${t.count} results${t.kept != null ? ` · kept ${t.kept}` : ''} · ${t.ms}ms${t.note ? ` · <i>${esc(t.note)}</i>` : ''}${t.error ? ` · <span class="err">${esc(t.error)}</span>` : ''}
    <code class="params">${esc(Object.entries(t.params).map(([k, v]) => `${k}=${v}`).join('&'))}</code>
    ${t.dropped?.length ? `<span class="dropped">Vetted out: ${t.dropped.map(esc).join(' · ')}</span>` : ''}</li>`).join('')}</ol>`;
}

function render(plan) {
  const g = plan.gifts ?? {};
  const o = plan.outing ?? {};
  const read = [
    ...plan.loved.map((l) => `<b>${esc(l.name)}</b> <span class="pill">${esc(l.type)}</span>`),
    ...(plan.interests ?? []).map((i) => `<b>${esc(i.input)}</b> <span class="pill">interest</span>`),
  ];
  resultEl.innerHTML = `
    <section class="card summary">
      <h2>A ${esc(plan.occasion)} plan for ${esc(plan.friend)}</h2>
      <p>Kindred read ${read.join(', ')}.</p>
      ${plan.profile?.length ? `<p class="fp">Taste fingerprint: ${plan.profile.map((t) => `<span>${esc(t.name)}</span>`).join('')}</p>` : ''}
      ${cacheBadge(plan)}
      ${plan.warnings?.length ? `<ul class="warn">${plan.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    </section>
    <div class="grid">
      ${section('Gift: a brand they would actually use', 'Giftable categories only; mass-market names skipped', g.brands)}
      ${section('Gift: a book to wrap', null, g.books)}
      ${section('Gift: an artist to discover', null, g.artists)}
      ${o.main?.picks?.length ? section(`Outing in ${o.city}: ${o.main.label}`, `${o.label} · independent spots, checked for venue type and hours`, o.main.picks) : ''}
      ${o.after?.picks?.length ? section(`Outing in ${o.city}: ${o.after.label}`, null, o.after.picks) : ''}
    </div>
    <details class="card trace"><summary>How the agent worked it out (${plan.trace.length} Qloo calls${plan.cache?.hit ? ', replayed from cache' : ''}, ${(plan.ms / 1000).toFixed(1)}s)</summary>
      ${traceList(plan.trace)}
    </details>`;
  resultEl.hidden = false;
  checkCard.hidden = false;
  checkResult.innerHTML = '';
}

async function submitPlan(body) {
  const btn = $('.go', form);
  btn.disabled = true;
  statusEl.textContent = 'Reading their taste, then planning gifts and an outing…';
  resultEl.hidden = true;
  checkCard.hidden = true;
  try {
    const res = await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const plan = await res.json();
    if (!plan.ok) { statusEl.textContent = plan.error || 'Something went wrong.'; return; }
    lastRequest = body;
    statusEl.textContent = '';
    render(plan);
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch {
    statusEl.textContent = 'Network error. Please try again.';
  } finally {
    btn.disabled = false;
  }
}

form.addEventListener('submit', (e) => { e.preventDefault(); submitPlan(readForm()); });

// ---- Would they like it? ----
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
    ${r.alternatives?.length ? `<p class="sub">Stronger fits in the same category:</p>${r.alternatives.map(itemCard).join('')}` : ''}
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
    const { loves, interests, city, friend } = lastRequest;
    const res = await fetch('/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ friend, loves, interests, city, candidate }) });
    renderCheck(await res.json());
  } catch {
    checkResult.innerHTML = '<p class="warn">Network error. Please try again.</p>';
  } finally {
    btn.disabled = false;
  }
});

loadExamples();
