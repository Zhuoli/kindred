// Kindred planning agent (deterministic planner, no LLM).
//
// Loop: resolve loves + free-text interests -> taste fingerprint -> plan tool
// calls -> execute in parallel, vetting every result (giftable? right venue
// type? chain?) and relaxing filters when too little survives -> explain -> compose.
// Every tool call is recorded in `trace` so the UI can show what the agent did.

import { QlooError } from './qloo.js';
import { OUTING_PRESETS, vetVenues, primaryGenre, kindLabel } from './venues.js';
import { BRAND_GIFT_TAGS, MAINSTREAM_CAP, brandRejectReason, diversify, GIFT_IDEA } from './gifts.js';
import { resolveInterests } from './interests.js';

export { OUTING_PRESETS };
export const ALGO_VERSION = 'kindred-2026-10-06b';

export const SEARCH_TYPES = [
  'urn:entity:artist', 'urn:entity:movie', 'urn:entity:tv_show', 'urn:entity:book',
  'urn:entity:podcast', 'urn:entity:videogame', 'urn:entity:person', 'urn:entity:brand', 'urn:entity:place',
];

const LIMITS = { loves: 6, interests: 3, text: 80 };

const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
const list = (v, max) => {
  const raw = Array.isArray(v) ? v : String(v ?? '').split(/\n|,/);
  return [...new Set(raw.map(clean).filter(Boolean).map((s) => s.slice(0, LIMITS.text)))].slice(0, max + 1);
};

export function validateRequest(input) {
  const errors = [];
  const body = input && typeof input === 'object' ? input : {};
  const friend = clean(body.friend).slice(0, 40) || 'your friend';
  const loves = list(body.loves, LIMITS.loves);
  const interests = list(body.interests, LIMITS.interests);
  if (loves.length === 0 && interests.length === 0) errors.push('Add at least one thing your friend loves (an artist, film, show, book, brand or place) or an interest.');
  if (loves.length > LIMITS.loves) errors.push(`Use at most ${LIMITS.loves} loves.`);
  if (interests.length > LIMITS.interests) errors.push(`Use at most ${LIMITS.interests} interests.`);
  const city = clean(body.city).slice(0, LIMITS.text);
  const occasion = clean(body.occasion).slice(0, 40) || 'just because';
  let budget = Number.parseInt(body.budget ?? 3, 10);
  if (!Number.isFinite(budget)) budget = 3;
  budget = Math.min(4, Math.max(1, budget));
  const vibe = Object.hasOwn(OUTING_PRESETS, body.vibe) ? body.vibe : 'dinner';
  const surprise = Boolean(body.surprise); // cap popularity to avoid the obvious picks
  return { ok: errors.length === 0, errors, value: { friend, loves, interests, city, occasion, budget, vibe, surprise } };
}

export function validateCheck(input) {
  const base = validateRequest(input);
  const candidate = clean(input?.candidate).slice(0, LIMITS.text);
  const errors = [...base.errors];
  if (!candidate) errors.push('Name the gift or place you have in mind.');
  return { ok: errors.length === 0, errors, value: { ...base.value, candidate } };
}

function norm(s) { return clean(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

/** Pick the best search hit for a free-text "love". */
export function pickBest(query, results, city) {
  if (!results?.length) return null;
  const q = norm(query);
  const cityN = norm(city);
  const usable = results.filter((r) => {
    const isPlace = r.types?.includes('urn:entity:place');
    if (!isPlace || !cityN) return true;
    return norm(r.properties?.address).includes(cityN);
  });
  const pool = usable.length ? usable : results.filter((r) => !r.types?.includes('urn:entity:place'));
  if (!pool.length) return null;
  const exact = pool.filter((r) => norm(r.name) === q);
  if (exact.length) return exact.slice().sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))[0];
  // A fuzzy hit only counts when it contains the phrase or shares most of its words.
  const words = q.split(' ').filter((w) => w.length > 2);
  const fuzzy = pool.find((r) => {
    const n = norm(r.name);
    if (n.includes(q) || (n.length > 3 && q.includes(n))) return true;
    const nw = new Set(n.split(' '));
    return words.length > 0 && words.filter((w) => nw.has(w)).length > words.length / 2;
  });
  return fuzzy ?? null;
}

const TYPE_LABEL = {
  'urn:entity:artist': 'artist', 'urn:entity:movie': 'film', 'urn:entity:tv_show': 'TV show',
  'urn:entity:book': 'book', 'urn:entity:podcast': 'podcast', 'urn:entity:brand': 'brand',
  'urn:entity:place': 'place', 'urn:entity:person': 'person', 'urn:entity:videogame': 'video game',
};
export const typeLabel = (t) => TYPE_LABEL[t] || String(t || '').split(':').pop();

/** Turn Qloo explainability into "because they love X" names. */
export function explain(entity, lovedById) {
  const ex = entity?.query?.explainability?.['signal.interests.entities'] ?? [];
  const known = ex.filter((e) => lovedById.has(e.entity_id) && (e.score ?? 0) >= 0.15)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const top = known[0]?.score ?? 0;
  // Keep the inputs that really drove this pick: within half of the strongest, max two.
  return known
    .filter((e) => e.score >= top * 0.5)
    .slice(0, 2)
    .map((e) => ({ name: lovedById.get(e.entity_id), score: Math.round((e.score ?? 0) * 100) / 100 }));
}

/** Interests whose tag appears on the entity ("because they're into natural wine"). */
export function interestMatches(entity, interestTags) {
  const ids = new Set((entity?.tags ?? []).map((t) => t.id ?? t.tag_id));
  return interestTags.filter((t) => ids.has(t.id)).map((t) => t.input);
}

export function summarize(entity, ctx = {}) {
  const { lovedById = new Map(), profileTagIds = new Set(), interestTags = [], domain = null } = ctx;
  const p = entity.properties ?? {};
  const sharedTags = (entity.tags ?? [])
    .filter((t) => profileTagIds.has(t.tag_id ?? t.id))
    .map((t) => t.name)
    .slice(0, 3);
  const type = typeLabel(entity.subtype || entity.types?.[0]);
  const isPlace = type === 'place';
  return {
    id: entity.entity_id,
    name: entity.name,
    type,
    kind: isPlace ? kindLabel(primaryGenre(entity)) : null,
    idea: domain && GIFT_IDEA[domain] ? GIFT_IDEA[domain](entity.name) : null,
    image: p.image?.url ?? p.images?.[0]?.url ?? null,
    description: p.short_description || p.description || null,
    address: p.address ?? null,
    priceLevel: p.price_level ?? null,
    website: typeof p.website === 'string' && /^https?:\/\//.test(p.website) ? p.website : null,
    affinity: entity.query?.affinity != null ? Math.round(entity.query.affinity * 1000) / 1000 : null,
    popularity: entity.popularity != null ? Math.round(entity.popularity * 1000) / 1000 : null,
    because: explain(entity, lovedById),
    into: interestMatches(entity, interestTags),
    sharedTags,
  };
}

/** Parameters shown in the public trace (never includes credentials). */
function traceParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') out[k] = v;
  return out;
}

/** Shared tool runner + resolution used by both plans and "would they like it?" checks. */
function makeRunner({ qloo, now }) {
  const trace = [];
  async function tool(step, endpoint, params, fn) {
    const t0 = now();
    try {
      const out = await fn();
      const count = Array.isArray(out) ? out.length : (out?.entities?.length ?? out?.tags?.length ?? 0);
      trace.push({ step, endpoint, params: traceParams(params), count, ms: now() - t0 });
      return out;
    } catch (err) {
      const msg = err instanceof QlooError ? err.message : 'unexpected error';
      trace.push({ step, endpoint, params: traceParams(params), count: 0, ms: now() - t0, error: msg });
      // Auth/config problems abort the run; anything else degrades gracefully.
      if (!(err instanceof QlooError) || err.status === 401) throw err;
      return null;
    }
  }

  /**
   * Insights call that vets its results and relaxes its own constraints when
   * too few survive. Returns { kept, dropped, entities }.
   */
  async function insightsVetted(step, attempts, { vet = (es) => ({ picks: es, dropped: [] }), min = 1 } = {}) {
    let last = { kept: [], dropped: [], entities: [] };
    for (let i = 0; i < attempts.length; i++) {
      const params = attempts[i];
      const res = await tool(i === 0 ? step : `${step} (relaxed)`, '/v2/insights', params, () => qloo.insights(params));
      if (res === null) break; // the call errored; relaxing filters would not help
      const entry = trace[trace.length - 1];
      const { picks, dropped } = vet(res.entities ?? [], res);
      entry.kept = picks.length;
      if (dropped.length) entry.dropped = dropped.slice(0, 6).map((d) => `${d.name}: ${d.why}`);
      if (i > 0) entry.note = 'too few results survived; agent relaxed filters';
      last = { kept: picks, dropped, entities: res.entities ?? [], tags: res.tags ?? [] };
      if (picks.length >= min || (res.tags ?? []).length) return last;
    }
    return last;
  }

  async function resolveAll({ loves, interests, city }) {
    const warnings = [];
    const resolved = [];
    const fallback = [];
    await Promise.all(loves.map(async (love, idx) => {
      const params = { query: love, types: SEARCH_TYPES.join(','), take: 6 };
      const hits = await tool(`resolve "${love}"`, '/search', params, () => qloo.search(love, { types: params.types, take: 6 }));
      const best = pickBest(love, hits ?? [], city);
      if (best) resolved[idx] = { input: love, id: best.entity_id, name: best.name, type: typeLabel(best.types?.[0]), image: best.properties?.image?.url ?? null };
      else fallback.push(love);
    }));
    const phrases = [...interests, ...fallback];
    let interestTags = [];
    if (phrases.length) {
      const r = await resolveInterests(phrases, { qloo, tool });
      warnings.push(...r.warnings.map((w) => (fallback.some((f) => w.includes(`"${f}"`)) ? w.replace('the interest', '').replace('  ', ' ') : w)));
      interestTags = r.interests;
      for (const f of fallback) if (r.interests.some((x) => x.input === f)) warnings.push(`"${f}" isn't a specific title or name in Qloo, so Kindred read it as an interest.`);
    }
    return { loved: resolved.filter(Boolean), interestTags, warnings };
  }

  return { trace, tool, insightsVetted, resolveAll };
}

const MEDIA = new Set(['artist', 'film', 'TV show', 'book', 'podcast', 'video game', 'person']);

function signalsFor(loved, interestTags) {
  const ids = loved.map((l) => l.id);
  const media = loved.filter((l) => MEDIA.has(l.type)).map((l) => l.id);
  return {
    ids,
    mediaIds: media.length ? media : ids,
    giftTags: [...new Set(interestTags.map((t) => t.gift?.id).filter(Boolean))],
    placeTags: [...new Set(interestTags.map((t) => t.place?.id).filter(Boolean))],
    interestList: [
      ...interestTags.filter((t) => t.gift).map((t) => ({ id: t.gift.id, input: t.input })),
      ...interestTags.filter((t) => t.place).map((t) => ({ id: t.place.id, input: t.input })),
    ],
  };
}

function signalParams(entityIds, tagIds, { explain: ex = true, exclude = entityIds } = {}) {
  const p = {};
  if (entityIds.length) p['signal.interests.entities'] = entityIds.join(',');
  if (tagIds.length) p['signal.interests.tags'] = tagIds.join(',');
  if (ex && entityIds.length) p['feature.explainability'] = true;
  if (exclude.length) p['filter.exclude.entities'] = exclude.join(',');
  return p;
}

export async function runAgent(input, { qloo, now = () => Date.now() }) {
  const started = now();
  const { trace, insightsVetted, resolveAll } = makeRunner({ qloo, now });
  const { friend, loves, interests = [], city, occasion, budget, vibe, surprise } = input;

  // 1. Resolve free-text loves to Qloo entities, and interests to Qloo tags.
  const { loved, interestTags, warnings } = await resolveAll({ loves, interests, city });
  if (!loved.length && !interestTags.length) {
    return { ok: false, friend, error: 'None of those loves matched anything in Qloo. Try specific names, e.g. "Phoebe Bridgers" or "Lady Bird".', warnings, trace, ms: now() - started };
  }
  const sig = signalsFor(loved, interestTags);
  const lovedById = new Map(loved.map((l) => [l.id, l.name]));

  // 2. Taste fingerprint (Taste Analysis = Insights with filter.type=urn:tag).
  let profile = [];
  if (sig.ids.length) {
    const profileParams = { 'filter.type': 'urn:tag', 'filter.tag.types': 'urn:tag:genre:media', 'signal.interests.entities': sig.mediaIds.join(','), take: 8 };
    const r = await insightsVetted('taste fingerprint', [profileParams], { vet: () => ({ picks: [], dropped: [] }) });
    profile = (r.tags ?? []).map((t) => ({ id: t.tag_id ?? t.id, name: t.name.replace(/^\+/, ''), affinity: t.query?.affinity ?? null }));
  }
  const profileTagIds = new Set(profile.map((t) => t.id));
  const ctx = { lovedById, profileTagIds, interestTags: sig.interestList };
  const lovedNames = new Set(loved.map((l) => norm(l.name)));
  const fresh = (es) => {
    const seen = new Set(lovedNames);
    return es.filter((e) => { const k = norm(e.name); if (seen.has(k)) return false; seen.add(k); return true; });
  };

  // 3. Plan gift + outing tool calls and run them in parallel.
  const cap = surprise ? MAINSTREAM_CAP.surprise : MAINSTREAM_CAP.normal;
  const brandBase = { 'filter.type': 'urn:entity:brand', ...signalParams(sig.ids, sig.giftTags), take: 24 };
  const giftJobs = {
    brands: insightsVetted('gift: brands', [
      { ...brandBase, 'filter.tags': BRAND_GIFT_TAGS.join(','), 'operator.filter.tags': 'union', 'filter.popularity.max': cap },
      { ...brandBase, 'filter.tags': BRAND_GIFT_TAGS.join(','), 'operator.filter.tags': 'union' },
      brandBase,
    ], {
      min: 3,
      vet: (es) => {
        const dropped = [];
        const picks = fresh(es).filter((e) => { const why = brandRejectReason(e, { cap }); if (why) dropped.push({ name: e.name, why }); return !why; });
        return { picks: diversify(picks, 4), dropped };
      },
    }),
    books: insightsVetted('gift: books', [
      { 'filter.type': 'urn:entity:book', ...signalParams(sig.mediaIds, sig.giftTags, { exclude: sig.ids }), ...(surprise ? { 'filter.popularity.max': 0.9 } : {}), take: 16 },
      { 'filter.type': 'urn:entity:book', ...signalParams(sig.mediaIds, sig.giftTags, { exclude: sig.ids }), take: 16 },
    ], {
      vet: (es) => {
        const f = fresh(es);
        const tagged = f.filter((e) => (e.tags ?? []).length);
        return { picks: diversify(tagged.length >= 4 ? tagged : f, 4), dropped: [] };
      },
    }),
    artists: insightsVetted('gift: artists', [
      { 'filter.type': 'urn:entity:artist', ...signalParams(sig.mediaIds, sig.giftTags, { exclude: sig.ids }), ...(surprise ? { 'filter.popularity.max': 0.9 } : {}), take: 12 },
      { 'filter.type': 'urn:entity:artist', ...signalParams(sig.mediaIds, sig.giftTags, { exclude: sig.ids }), take: 12 },
    ], { vet: (es) => ({ picks: diversify(fresh(es), 4), dropped: [] }) }),
  };

  const preset = OUTING_PRESETS[vibe];
  const placeAttempts = (leg) => {
    const p = {
      'filter.type': 'urn:entity:place', ...signalParams(sig.ids, sig.placeTags),
      'filter.location.query': city, 'filter.tags': leg.tags.join(','), 'operator.filter.tags': 'union', take: 20,
    };
    if (leg.exclude?.length) p['filter.exclude.tags'] = leg.exclude.join(',');
    if (leg.priced) {
      p['filter.price_level.max'] = budget;
      if (budget >= 3) p['filter.price_level.min'] = budget - 1;
    }
    const relaxed = { ...p };
    delete relaxed['filter.price_level.max'];
    delete relaxed['filter.price_level.min'];
    relaxed['filter.location.radius'] = 25000;
    return leg.priced ? [p, relaxed] : [p, { ...p, 'filter.location.radius': 25000 }];
  };
  const outingJobs = {};
  if (city) {
    for (const key of ['main', 'after']) {
      const leg = preset[key];
      outingJobs[key] = insightsVetted(`outing: ${leg.label.toLowerCase()}`, placeAttempts(leg), {
        min: 2, vet: (es) => vetVenues(fresh(es), leg, { n: 4 }),
      });
    }
  } else {
    warnings.push('No city given, so the agent skipped the outing plan.');
  }

  const [brands, books, artists, main, after] = await Promise.all([
    giftJobs.brands, giftJobs.books, giftJobs.artists, outingJobs.main, outingJobs.after,
  ]);
  const gifts = {
    brands: brands.kept.slice(0, 4).map((e) => summarize(e, { ...ctx, domain: 'brand' })),
    books: books.kept.slice(0, 4).map((e) => summarize(e, { ...ctx, domain: 'book' })),
    artists: artists.kept.slice(0, 4).map((e) => summarize(e, { ...ctx, domain: 'artist' })),
  };
  const outing = { vibe, label: preset.label, city: city || null, main: null, after: null };
  if (main) {
    const mainPicks = main.kept.slice(0, 3);
    const mainIds = new Set(mainPicks.map((e) => e.entity_id));
    outing.main = { label: preset.main.label, picks: mainPicks.map((e) => summarize(e, ctx)) };
    outing.after = { label: preset.after.label, picks: after.kept.filter((e) => !mainIds.has(e.entity_id)).slice(0, 3).map((e) => summarize(e, ctx)) };
    for (const key of ['main', 'after']) {
      if (!outing[key].picks.length) warnings.push(`Kindred couldn't find a ${preset[key].label.toLowerCase()} spot in ${city} that passed its checks.`);
    }
  }

  return {
    ok: true,
    version: ALGO_VERSION,
    friend, occasion, city: city || null, budget, surprise,
    loved, interests: interestTags.map((t) => ({ input: t.input, place: t.place?.name ?? null, gift: t.gift?.name ?? null })),
    profile, gifts, outing, warnings, trace,
    ms: now() - started,
  };
}

/** Affinity -> plain-language verdict. Thresholds calibrated on live Qloo scores. */
export function verdict(affinity, bestAlternative = null) {
  if (affinity == null) return { label: 'Not enough signal', level: 'unknown' };
  let v;
  if (affinity >= 0.92) v = { label: 'Yes, strong match', level: 'great' };
  else if (affinity >= 0.85) v = { label: 'Likely, good match', level: 'good' };
  else if (affinity >= 0.78) v = { label: 'A stretch', level: 'meh' };
  else v = { label: 'Probably not', level: 'poor' };
  if (bestAlternative != null && affinity >= bestAlternative - 0.01 && affinity >= 0.85) v.note = 'As strong as Kindred\'s own top picks.';
  return v;
}

/** "Would they like it?" Score one candidate against the friend's taste. */
export async function runCheck(input, { qloo, now = () => Date.now() }) {
  const started = now();
  const { trace, tool, insightsVetted, resolveAll } = makeRunner({ qloo, now });
  const { friend, loves, interests = [], city, candidate } = input;

  const [{ loved, interestTags, warnings }, hits] = await Promise.all([
    resolveAll({ loves, interests, city }),
    tool(`resolve candidate "${candidate}"`, '/search', { query: candidate, types: SEARCH_TYPES.join(','), take: 6 },
      () => qloo.search(candidate, { types: SEARCH_TYPES.join(','), take: 6 })),
  ]);
  if (!loved.length && !interestTags.length) return { ok: false, friend, error: 'None of their loves matched anything in Qloo, so there is nothing to compare against.', warnings, trace, ms: now() - started };
  const best = pickBest(candidate, hits ?? [], city);
  if (!best) return { ok: false, friend, error: `Couldn't find "${candidate}" in Qloo. Try the exact name of a brand, book, artist, film or place.`, warnings, trace, ms: now() - started };
  if (loved.some((l) => l.id === best.entity_id)) {
    return { ok: true, friend, candidate: { id: best.entity_id, name: best.name, type: typeLabel(best.types?.[0]) }, verdict: { label: 'They already love it', level: 'great' }, affinity: null, because: [], alternatives: [], warnings, trace, ms: now() - started };
  }

  const type = best.types?.[0];
  const sig = signalsFor(loved, interestTags);
  const signalIds = type === 'urn:entity:brand' || type === 'urn:entity:place' ? sig.ids : sig.mediaIds;
  const tags = type === 'urn:entity:place' ? sig.placeTags : sig.giftTags;
  const scoreParams = { 'filter.type': type, ...signalParams(signalIds, tags, { exclude: [] }), 'filter.results.entities': best.entity_id };
  const altParams = { 'filter.type': type, ...signalParams(signalIds, tags, { exclude: [...sig.ids, best.entity_id] }), take: 12 };
  if (type === 'urn:entity:place' && city) altParams['filter.location.query'] = city;
  if (type === 'urn:entity:brand') Object.assign(altParams, { 'filter.tags': BRAND_GIFT_TAGS.join(','), 'operator.filter.tags': 'union', 'filter.popularity.max': MAINSTREAM_CAP.normal });

  const [scored, alts] = await Promise.all([
    insightsVetted(`score "${best.name}"`, [scoreParams]),
    insightsVetted(`alternatives (${typeLabel(type)})`, [altParams], {
      vet: (es) => ({ picks: type === 'urn:entity:brand' ? es.filter((e) => !brandRejectReason(e)) : es, dropped: [] }),
    }),
  ]);
  const hit = scored.entities.find((e) => e.entity_id === best.entity_id) ?? scored.entities[0];
  const lovedById = new Map(loved.map((l) => [l.id, l.name]));
  const ctx = { lovedById, profileTagIds: new Set(), interestTags: sig.interestList };
  const affinity = hit?.query?.affinity ?? null;
  const alternatives = alts.kept.slice(0, 3).map((e) => summarize(e, ctx));
  return {
    ok: true,
    version: ALGO_VERSION,
    friend,
    candidate: hit ? summarize(hit, ctx) : { id: best.entity_id, name: best.name, type: typeLabel(type) },
    affinity: affinity != null ? Math.round(affinity * 1000) / 1000 : null,
    verdict: verdict(affinity, alternatives[0]?.affinity ?? null),
    because: hit ? explain(hit, lovedById) : [],
    alternatives,
    warnings, trace, ms: now() - started,
  };
}
