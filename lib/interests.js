// Free-text interests ("natural wine", "vinyl", "hiking") become Qloo tags via
// GET /v2/tags. Place tags steer the outing; brand/media tags steer gifts.

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const PLACE_PREF = ['genre:place', 'cuisine:qloo', 'interests:qloo', 'activities:place', 'good_for:qloo', 'menu_highlight:qloo', 'offerings:place', 'ambience:qloo', 'category:place'];
const GIFT_PREF = ['genre:brand', 'lifestyle:qloo', 'keyword:qloo', 'keyword:media', 'genre:media', 'subgenre:qloo', 'style:qloo', 'theme:qloo', 'genre:qloo', 'aesthetic_property:qloo'];
const IGNORE = /decor|nearby_attraction|specialty_dish|neighborhood|parking|payments|credit_card|accessibility|amenit|wikipedia/;

const typeKey = (t) => String(t.type ?? '').replace(/^urn:tag:/, '');

/** Best matching tag for a phrase among Qloo tag-search results (null if none fits). */
export function pickTag(phrase, tags, prefs) {
  const q = norm(phrase);
  if (!q) return null;
  const words = q.split(' ');
  const scored = [];
  for (const t of tags ?? []) {
    const ty = typeKey(t);
    if (IGNORE.test(ty)) continue;
    const name = norm(t.name);
    const id = t.id ?? t.tag_id;
    let match = 0;
    if (name === q) match = 3;
    else if (name.startsWith(q) || name.endsWith(q)) match = 2;
    else if (words.every((w) => name.split(' ').includes(w))) match = 1;
    if (!match) continue;
    const pref = prefs.indexOf(ty);
    scored.push({ id, name: t.name, type: ty, score: match * 100 - (pref === -1 ? 50 : pref) - name.length * 0.1 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0] ?? null;
}

/**
 * Resolve phrases to { place, gift } tags. `tool` wraps calls so they show in the trace.
 * Returns [{ input, place, gift }] and warnings.
 */
export async function resolveInterests(phrases, { qloo, tool }) {
  const out = [];
  const warnings = [];
  await Promise.all(phrases.map(async (phrase, i) => {
    const placeParams = { 'filter.query': phrase, 'filter.parents.types': 'urn:entity:place', take: 15 };
    const giftParams = { 'filter.query': phrase, 'filter.parents.types': 'urn:entity:brand,urn:entity:book,urn:entity:artist,urn:entity:movie', take: 15 };
    const [pt, gt] = await Promise.all([
      tool(`interest "${phrase}" (places)`, '/v2/tags', placeParams, () => qloo.tags(phrase, { parentTypes: placeParams['filter.parents.types'], take: 15 })),
      tool(`interest "${phrase}" (gifts)`, '/v2/tags', giftParams, () => qloo.tags(phrase, { parentTypes: giftParams['filter.parents.types'], take: 15 })),
    ]);
    const place = pickTag(phrase, pt, PLACE_PREF);
    const gift = pickTag(phrase, gt, GIFT_PREF);
    if (place || gift) out[i] = { input: phrase, place, gift };
    else warnings.push(`Couldn't match the interest "${phrase}" to Qloo's tags, so it was skipped.`);
  }));
  return { interests: out.filter(Boolean), warnings };
}
