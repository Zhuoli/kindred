// Gift relevance: keep brands you can actually wrap, skip mass-market names,
// and spread picks across different styles instead of five near-duplicates.

export const BRAND_GIFT_TAGS = [
  'urn:tag:genre:brand:fashion',
  'urn:tag:genre:brand:health_and_beauty',
  'urn:tag:genre:brand:fashion:home_accessories',
];

/** Popularity percentile above which a brand counts as mass-market. */
export const MAINSTREAM_CAP = { normal: 0.98, surprise: 0.93 };

const tagNames = (e, type) => (e?.tags ?? []).filter((t) => t.type === type).map((t) => t.name);
const GENERIC = /^(Fashion|Other|Casual|Lifestyle \/ Casual|Website|Accessories)$/;
const NOT_GIFTS = /^(Lingerie & Sleepwear|Swimwear|Underwear|Mobile App|Software|Healthcare App|Insurance|Banking|Sports Organization|National Football League|National Hockey League|Food & Beverage|Drinks|Coffee & Tea|Travel|Telecom)$/;

/** Why a brand would be a poor gift, or null if it is giftable. */
export function brandRejectReason(e, { cap = MAINSTREAM_CAP.normal } = {}) {
  const genres = tagNames(e, 'urn:tag:genre:brand');
  const subtype = tagNames(e, 'urn:tag:brand_subtype:qloo');
  const type = tagNames(e, 'urn:tag:brand_type:qloo');
  if (!e?.popularity || !type.length) return 'too little data';
  if (subtype.includes('CPG')) return 'everyday consumable';
  if (type.some((t) => /Government|Entertainment|Service/.test(t))) return `${type[0].toLowerCase()}, not a gift`;
  // Reject on category only when it is what the brand is *about* (Smartwool also lists
  // "Lingerie & Sleepwear", but its socks make a fine gift).
  const specific = genres.filter((g) => !GENERIC.test(g));
  if (specific.length && specific.every((g) => NOT_GIFTS.test(g))) return specific[0].toLowerCase();
  if (genres.includes('Eyewear') && type.includes('Retail Brand')) return 'prescription eyewear retailer';
  if (e.popularity > cap) return 'mass-market';
  return null;
}

function tagSet(e) {
  return new Set((e?.tags ?? [])
    .filter((t) => /genre|subgenre|style|aesthetic|lifestyle|keyword/.test(t.type ?? ''))
    .map((t) => t.id ?? t.tag_id));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Maximal-marginal-relevance re-rank: start from Qloo's affinity order, but
 * penalise items that share most of their tags with something already picked.
 */
export function diversify(entities, n, { lambda = 0.35 } = {}) {
  const pool = (entities ?? []).map((e, i) => ({ e, tags: tagSet(e), score: e.query?.affinity ?? 1 - i * 0.01 }));
  const out = [];
  while (out.length < n && pool.length) {
    let best = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const sim = out.length ? Math.max(...out.map((o) => jaccard(o.tags, pool[i].tags))) : 0;
      const val = pool[i].score - lambda * sim;
      if (val > bestVal) { bestVal = val; best = i; }
    }
    out.push(pool.splice(best, 1)[0]);
  }
  return out.map((x) => x.e);
}

/** Gift suggestion wording per domain. */
export const GIFT_IDEA = {
  brand: (name) => `Something from ${name}`,
  book: () => 'A hardcover copy',
  artist: () => 'A vinyl record or concert tickets',
  movie: () => 'A boutique Blu-ray edition',
  tv_show: () => 'A box set or a themed watch night',
};
