// "Us" mode: plan something for two people at once (you + your friend).
//
// Loop: resolve both people's loves -> compare the two taste profiles with
// /v2/insights/compare (common ground) -> run blended Insights calls signalled by
// BOTH people's loves -> use per-pick explainability to attribute each pick to
// whose taste drove it -> re-rank toward picks that serve both, and keep the final
// set fair (neither person gets most of the plan) -> compose.

import { OUTING_PRESETS, vetVenues, primaryGenre, kindLabel } from './venues.js';
import {
  makeRunner, validateRequest, clean, list, norm, LIMITS, summarize, signalsFor, signalParams, outingAttempts,
} from './agent.js';
import { diversify } from './gifts.js';

export const TOGETHER_VERSION = 'kindred-us-2026-10-18';

export function validateTogether(input) {
  const body = input && typeof input === 'object' ? input : {};
  const base = validateRequest(body);
  const errors = base.errors.filter((e) => !e.startsWith('Add at least one thing'));
  const you = clean(body.you).slice(0, 40) || 'you';
  const yourLoves = list(body.yourLoves, LIMITS.loves);
  const yourInterests = list(body.yourInterests, LIMITS.interests);
  if (base.value.loves.length === 0) errors.push(`Add at least one specific thing ${base.value.friend} loves, so Kindred can compare your tastes.`);
  if (yourLoves.length === 0) errors.push('Add at least one specific thing you love (an artist, film, show, book, brand or place).');
  if (yourLoves.length > LIMITS.loves) errors.push(`Use at most ${LIMITS.loves} of your own loves.`);
  if (yourInterests.length > LIMITS.interests) errors.push(`Use at most ${LIMITS.interests} of your own interests.`);
  const unique = [...new Set(errors)];
  return { ok: unique.length === 0, errors: unique, value: { mode: 'us', ...base.value, you, yourLoves, yourInterests } };
}

/** How many loved entities each side contributed (an entity both love counts for both). */
export function sideCounts(owners) {
  const c = { them: 0, you: 0 };
  for (const w of owners.values()) { if (w.has('them')) c.them += 1; if (w.has('you')) c.you += 1; }
  return c;
}

export const LEAN_BAND = 0.08; // |share - 0.5| within this band reads as "for both of you"

/**
 * Split a pick's Qloo explainability between the two people.
 * owners: Map(entityId -> Set('them' | 'you')). Each side's explainability is averaged
 * over the number of loves it gave, so listing more loves doesn't win by volume.
 * Returns { them, you, share, lean, balance } where share is them's weight (0-1).
 */
export function attribute(entity, owners, counts = sideCounts(owners)) {
  const ex = entity?.query?.explainability?.['signal.interests.entities'] ?? [];
  let them = 0;
  let you = 0;
  for (const e of ex) {
    const who = owners.get(e.entity_id);
    if (!who) continue;
    const s = e.score ?? 0;
    if (who.has('them')) them += s;
    if (who.has('you')) you += s;
  }
  const mt = counts.them ? them / counts.them : 0;
  const my = counts.you ? you / counts.you : 0;
  const total = mt + my;
  if (total <= 0) return { them: 0, you: 0, share: null, lean: 'unknown', balance: 0 };
  const share = mt / total;
  const lean = share > 0.5 + LEAN_BAND ? 'them' : share < 0.5 - LEAN_BAND ? 'you' : 'both';
  return { them: round(them), you: round(you), share: round(share), lean, balance: round(1 - Math.abs(share - 0.5) * 2) };
}
const round = (x) => Math.round(x * 100) / 100;

/** The loved entities behind a pick, labelled with whose love they are. */
export function becauseBoth(entity, owners, names) {
  const ex = (entity?.query?.explainability?.['signal.interests.entities'] ?? [])
    .filter((e) => owners.has(e.entity_id) && (e.score ?? 0) >= 0.15)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const top = ex[0]?.score ?? 0;
  return ex.filter((e) => e.score >= top * 0.5).slice(0, 3).map((e) => {
    const w = owners.get(e.entity_id);
    return { name: names.get(e.entity_id), who: w.size > 1 ? 'both' : [...w][0], score: round(e.score) };
  });
}

/** Rank by affinity, nudged toward picks that serve both people. */
export function blendScore(entity, attr) {
  const affinity = entity?.query?.affinity ?? 0.5;
  return affinity * (0.8 + 0.2 * (attr.lean === 'unknown' ? 0.5 : attr.balance));
}

/**
 * Pick n items so neither person dominates: the count of picks leaning to one side
 * never exceeds the other side by more than one while alternatives remain.
 */
export function fairPick(ranked, n) {
  const lean = { them: 0, you: 0 };
  const fits = (r) => {
    const side = r.attr.lean;
    if (side !== 'them' && side !== 'you') return true;
    return lean[side] - lean[side === 'them' ? 'you' : 'them'] < 1;
  };
  const take = (r) => { if (lean[r.attr.lean] != null) lean[r.attr.lean] += 1; out.push(r); };
  const out = [];
  const waiting = [];
  for (const r of ranked) {
    if (out.length >= n) break;
    if (!fits(r)) { waiting.push(r); continue; }
    take(r);
    // A pick for the other side (or for both) may let a better-ranked waiting pick back in.
    for (let i = 0; i < waiting.length && out.length < n; i++) {
      if (fits(waiting[i])) { take(waiting.splice(i, 1)[0]); i = -1; }
    }
  }
  for (const r of waiting) { if (out.length >= n) break; out.push(r); }
  // Selection order alternates sides, so any prefix of the list stays fair too.
  return out;
}

export function balanceOf(picks) {
  const b = { both: 0, them: 0, you: 0 };
  for (const p of picks) if (b[p.lean] != null) b[p.lean] += 1;
  return b;
}

const TOGETHER_IDEA = {
  film: 'A movie night in',
  show: 'A show to start together',
  artist: 'Put the record on, or catch them live',
};

const COMMON_PREF = ['genre', 'theme', 'style', 'character', 'subgenre', 'keyword', 'audience'];
/** Drop uninformative shared tags (a shared country says little) and put genres and themes first. */
export function commonTags(tags) {
  const kind = (t) => String(t.subtype ?? t.type ?? t.tag_id ?? '').replace(/^urn:tag:/, '').split(':')[0];
  const idKind = (t) => String(t.tag_id ?? t.id ?? '').replace(/^urn:tag:/, '').split(':')[0];
  const rankOf = (t) => { const k = COMMON_PREF.indexOf(idKind(t) || kind(t)); return k === -1 ? COMMON_PREF.length : k; };
  return tags
    .filter((t) => !/^(region|location|release|platform|wikipedia|demographic)/.test(idKind(t)) && !/media tie.?in/i.test(t.name ?? ''))
    .map((t, i) => ({ t, i, r: rankOf(t), s: t.query?.score ?? 0 }))
    .sort((a, b) => (b.s - a.s) || (a.r - b.r) || (a.i - b.i))
    .map((x) => x.t);
}

function tagName(t) { return String(t?.name ?? '').replace(/^\+/, ''); }

export async function runTogether(input, { qloo, now = () => Date.now(), onEvent = null }) {
  const started = now();
  const { trace, tool, insightsVetted, resolveAll, phase } = makeRunner({ qloo, now, onEvent });
  const { friend, you, loves, interests = [], yourLoves, yourInterests = [], city, occasion, budget, vibe, surprise } = input;

  // 1. Resolve both people's loves (identical lookups are served from the per-request cache).
  phase('resolve', `Matching what ${friend} and ${you === 'you' ? 'you' : you} love to Qloo's taste graph`);
  const [a, b] = await Promise.all([
    resolveAll({ loves, interests, city, who: friend }),
    resolveAll({ loves: yourLoves, interests: yourInterests, city, who: you }),
  ]);
  const warnings = [...a.warnings, ...b.warnings.map((w) => w.replace(/"([^"]+)"/, `your "$1"`))];
  if (!a.loved.length || !b.loved.length) {
    const who = !a.loved.length ? friend : 'you';
    return { ok: false, mode: 'us', friend, error: `None of the loves for ${who} matched anything in Qloo. Try specific names, e.g. "Phoebe Bridgers" or "Lady Bird".`, warnings, trace, ms: now() - started };
  }

  const owners = new Map();
  const names = new Map();
  for (const [side, set] of [['them', a.loved], ['you', b.loved]]) {
    for (const l of set) {
      if (!owners.has(l.id)) owners.set(l.id, new Set());
      owners.get(l.id).add(side);
      names.set(l.id, l.name);
    }
  }
  const sharedLoves = [...owners].filter(([, w]) => w.size > 1).map(([id]) => names.get(id));
  const sigA = signalsFor(a.loved, a.interestTags);
  const sigB = signalsFor(b.loved, b.interestTags);
  const uniq = (xs) => [...new Set(xs)];
  const sig = {
    ids: uniq([...sigA.ids, ...sigB.ids]),
    mediaIds: uniq([...sigA.mediaIds, ...sigB.mediaIds]),
    placeTags: uniq([...sigA.placeTags, ...sigB.placeTags]),
    giftTags: uniq([...sigA.giftTags, ...sigB.giftTags]),
  };
  const interestList = [...sigA.interestList, ...sigB.interestList];

  // 2. Common ground: compare the two taste profiles.
  phase('compare', `Comparing ${friend}'s taste with yours`);
  const cmp = await tool('common ground', '/v2/insights/compare',
    { 'a.signal.interests.entities': sigA.ids.join(','), 'b.signal.interests.entities': sigB.ids.join(','), take: 8 },
    () => qloo.compare(sigA.ids.join(','), sigB.ids.join(','), { take: 8 }));
  const shared = commonTags(cmp?.shared ?? []).slice(0, 6).map((t) => ({ id: t.tag_id ?? t.id, name: tagName(t), score: t.query?.score != null ? round(t.query.score) : null }));
  const sharedNames = new Set(shared.map((t) => t.name.toLowerCase()));
  const onlyOne = (tags) => [...new Set(commonTags(tags).map(tagName))].filter((n) => !sharedNames.has(n.toLowerCase())).slice(0, 4);
  const common = {
    shared,
    them: onlyOne(cmp?.a ?? []),
    you: onlyOne(cmp?.b ?? []),
    loves: sharedLoves,
  };

  // 3. Blended calls, attributed and re-ranked for fairness.
  phase('plan', city ? `Finding things you'd both enjoy and vetting an outing in ${city}` : "Finding things you'd both enjoy");
  const ctx = { lovedById: names, profileTagIds: new Set(common.shared.map((t) => t.id)), interestTags: interestList };
  const lovedNames = new Set([...names.values()].map(norm));
  const fresh = (es) => {
    const seen = new Set(lovedNames);
    return es.filter((e) => { const k = norm(e.name); if (seen.has(k)) return false; seen.add(k); return true; });
  };
  // posPenalty keeps some of an upstream ordering (venue vetting puts direct type matches first).
  // Each side's weight is averaged over the loves that actually signalled the call.
  const countsFor = (ids) => sideCounts(new Map(ids.map((id) => [id, owners.get(id)])));
  const mediaCounts = countsFor(sig.mediaIds);
  const allCounts = countsFor(sig.ids);
  const rank = (es, posPenalty = 0, counts = allCounts) => es.map((e, i) => ({ e, attr: attribute(e, owners, counts), i }))
    .map((r) => ({ ...r, score: blendScore(r.e, r.attr) - posPenalty * r.i }))
    .sort((x, y) => y.score - x.score);
  const pop = surprise ? { 'filter.popularity.max': 0.9 } : {};
  // (Steering these calls with the shared tags as signal.interests.tags made Qloo time out
  // in live tests, so common ground is used for display and tag matching instead.)
  const mediaAttempts = (type, take) => {
    const p = { 'filter.type': type, ...signalParams(sig.mediaIds, [], { exclude: sig.ids }), take };
    return surprise ? [{ ...p, ...pop }, p] : [p];
  };
  const mediaVet = (es) => ({ picks: fairPick(rank(diversify(fresh(es), 8), 0, mediaCounts), 4), dropped: [] });
  const jobs = {
    films: insightsVetted('together: films', mediaAttempts('urn:entity:movie', 16), { min: 3, vet: mediaVet }),
    shows: insightsVetted('together: shows', mediaAttempts('urn:entity:tv_show', 16), { min: 3, vet: mediaVet }),
    artists: insightsVetted('together: artists', mediaAttempts('urn:entity:artist', 16), { min: 3, vet: mediaVet }),
  };
  const preset = OUTING_PRESETS[vibe];
  if (city) {
    for (const key of ['main', 'after']) {
      const leg = preset[key];
      jobs[key] = insightsVetted(`outing: ${leg.label.toLowerCase()}`, outingAttempts(leg, { sig, city, budget }), {
        min: 2,
        vet: (es) => {
          const v = vetVenues(fresh(es), leg, { n: 8 });
          return { picks: fairPick(rank(v.picks, 0.01), 4), dropped: v.dropped };
        },
      });
    }
  } else {
    warnings.push('No city given, so the agent skipped the outing plan.');
  }
  const [films, shows, artists, main, after] = await Promise.all([jobs.films, jobs.shows, jobs.artists, jobs.main, jobs.after]);

  phase('compose', 'Explaining whose taste each pick serves');
  const card = (domain) => (r) => {
    const s = summarize(r.e, ctx);
    return { ...s, idea: TOGETHER_IDEA[domain] ?? null, because: becauseBoth(r.e, owners, names), lean: r.attr.lean, share: r.attr.share };
  };
  const together = {
    films: films.kept.slice(0, 3).map(card('film')),
    shows: shows.kept.slice(0, 3).map(card('show')),
    artists: artists.kept.slice(0, 3).map(card('artist')),
  };
  const outing = { vibe, label: preset.label, city: city || null, main: null, after: null };
  if (main) {
    const mainPicks = main.kept.slice(0, 3);
    const ids = new Set(mainPicks.map((r) => r.e.entity_id));
    outing.main = { label: preset.main.label, picks: mainPicks.map(card('place')) };
    outing.after = { label: preset.after.label, picks: after.kept.filter((r) => !ids.has(r.e.entity_id)).slice(0, 3).map(card('place')) };
    for (const key of ['main', 'after']) {
      if (!outing[key].picks.length) warnings.push(`Kindred couldn't find a ${preset[key].label.toLowerCase()} spot in ${city} that passed its checks.`);
    }
  }
  const all = [...together.films, ...together.shows, ...together.artists, ...(outing.main?.picks ?? []), ...(outing.after?.picks ?? [])];
  return {
    ok: true,
    mode: 'us',
    version: TOGETHER_VERSION,
    friend, you, occasion, city: city || null, budget, surprise,
    loved: { them: a.loved, you: b.loved },
    interests: {
      them: a.interestTags.map((t) => ({ input: t.input, place: t.place?.name ?? null, gift: t.gift?.name ?? null })),
      you: b.interestTags.map((t) => ({ input: t.input, place: t.place?.name ?? null, gift: t.gift?.name ?? null })),
    },
    common, together, outing,
    balance: balanceOf(all),
    warnings, trace,
    ms: now() - started,
  };
}

// Re-exported for the UI's kind labels on venue picks (keeps imports tidy in tests).
export { primaryGenre, kindLabel };
