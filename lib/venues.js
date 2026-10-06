// Venue validation for outing legs: every pick must really be the kind of place
// its leg promises (no cocktail bar under "Dinner", no bowling alley under
// "Drinks"), must be open in the evening when the leg is an evening one, and
// must not be a chain or mass-market spot.

export const G = 'urn:tag:genre:place:';
const R = `${G}restaurant:`;

const NOT_DINNER = 'cafe|coffee_shop|espresso_bar|bakery|patisserie|dessert|dessert_shop|ice_cream_shop|frozen_yogurt|donut_shop|bagel_shop|breakfast|brunch|lunch|bubble_tea_store|juice_shop|juice_bar|sandwich_shop|deli|bar|cocktail_bar|wine_bar|pub|lounge_bar|beer_bar|beer_hall|beer_garden|brewery|brewpub|sports_bar|dive_bar|night_club|hookah_bar|karaoke_bar|tea_house|cookie_shop|chocolate_shop|candy_store|food_court|fast_food|takeout|delivery|pizza_takeout|snack_bar|coffee_stand|caterer';
const BARS = 'bar|cocktail_bar|wine_bar|pub|lounge_bar|beer_bar|beer_hall|beer_garden|brewery|brewpub|speakeasy|sake_bar|whiskey_bar|tiki_bar|natural_wine|gastropub|wine_cellar|champagne_bar|piano_bar|jazz_bar|irish_pub';
const COFFEE = 'cafe|coffee_shop|espresso_bar|tea_house|coffee_roasters|bakery|patisserie|cat_cafe|tea_store';

/** Outing presets. Each leg says what to ask Qloo for and what to accept back. */
export const OUTING_PRESETS = {
  dinner: {
    label: 'Dinner, then drinks',
    main: {
      label: 'Dinner', priced: true, evening: true,
      tags: [`${G}restaurant`],
      exclude: ['coffee_shop', 'cafe', 'bakery', 'bar', 'cocktail_bar', 'wine_bar', 'ice_cream_shop', 'dessert_shop', 'donut_shop', 'bubble_tea_store', 'bagel_shop', 'fast_food'].map((t) => R + t),
      accept: new RegExp(`^restaurant(:|$)`), reject: new RegExp(`^restaurant:(${NOT_DINNER})$`),
    },
    after: {
      label: 'Drinks', evening: true,
      tags: [`${R}cocktail_bar`, `${R}wine_bar`],
      exclude: [`${R}coffee_shop`, `${R}cafe`, `${G}night_club`],
      accept: new RegExp(`^(restaurant:(${BARS})|lounge|bar|wine_bar|cocktail_bar)$`),
    },
  },
  daytime: {
    label: 'Coffee and wander',
    main: {
      label: 'Coffee', priced: false,
      tags: [`${R}cafe`, `${R}coffee_shop`],
      exclude: [`${R}fast_food`, `${R}donut_shop`, `${R}bubble_tea_store`, `${R}ice_cream_shop`],
      accept: new RegExp(`^(restaurant:)?(${COFFEE})$`),
    },
    after: {
      label: 'Wander',
      tags: [`${G}museum`, `${G}book_store`, `${G}record_store`, `${G}art_gallery`],
      accept: /^(.*museum.*|art_gallery|.*book_store|record_store|music_store|library|botanical_garden|art_center|cultural_center|antique_store|vintage_clothing_store)$/,
    },
  },
  night: {
    label: 'Drinks and live music',
    main: {
      label: 'Drinks', priced: true, evening: true,
      tags: [`${R}cocktail_bar`, `${R}bar`, `${R}wine_bar`],
      exclude: [`${R}coffee_shop`, `${R}cafe`, `${R}sports_bar`],
      accept: new RegExp(`^(restaurant:(${BARS})|lounge|bar|wine_bar|cocktail_bar)$`),
    },
    after: {
      // No evening-hours check here: venue hours are usually box-office hours.
      label: 'Live music',
      tags: [`${G}live_music_venue`, `${G}jazz_club`, `${G}concert_hall`],
      acceptTags: /^(live_music_venue|jazz_club|concert_hall|music_venue|musical_club)$/,
      rejectPrimary: /^(restaurant(:.*)?|museum|.*store|.*shop|tourist_attraction|hotel)$/,
      accept: /^(live_music_venue|jazz_club|concert_hall|music_venue|musical_club|blues_club|amphitheater|opera_house|restaurant:jazz_bar|restaurant:piano_bar)$/,
    },
  },
};

const short = (id) => String(id || '').replace(G, '');

/** The venue's primary type, e.g. "restaurant:greek" (falls back to good_for / genre tags). */
export function primaryGenre(e) {
  const p = e?.properties ?? {};
  if (p.primary_genre?.id) return short(p.primary_genre.id);
  const gf = (p.good_for ?? []).find((g) => String(g.id).startsWith(G));
  if (gf) return short(gf.id);
  const genres = (e?.tags ?? []).filter((t) => t.type === 'urn:tag:genre:place' && t.id !== 'urn:tag:genre:place').map((t) => short(t.id));
  return genres.sort((a, b) => b.split(':').length - a.split(':').length)[0] ?? null;
}

const TITLE = { cafe: 'Café', bbq: 'BBQ', restaurant: 'Restaurant' };
/** "restaurant:greek" -> "Greek restaurant", "restaurant:cocktail_bar" -> "Cocktail bar". */
export function kindLabel(genre) {
  if (!genre) return null;
  const parts = genre.split(':');
  const leaf = parts[parts.length - 1];
  const words = leaf.split('_').join(' ');
  const cap = TITLE[leaf] ?? words.charAt(0).toUpperCase() + words.slice(1);
  const isCuisine = parts[0] === 'restaurant' && parts.length > 1 && !new RegExp(`^(${NOT_DINNER}|${BARS}|${COFFEE}|diner|izakaya|steak_house|tapas|oyster_bar|bistro|brasserie|trattoria|taqueria|gastropub|steakhouse)$`).test(leaf);
  return isCuisine ? `${cap} restaurant` : cap;
}

/** true / false when the hours say whether it is open after 7pm on some day; null if unknown. */
export function opensEvenings(e) {
  const h = e?.properties?.hours;
  if (!h || typeof h !== 'object') return null;
  let known = false;
  for (const day of Object.values(h)) {
    for (const s of day ?? []) {
      if (s?.closed || !s?.closes) continue;
      known = true;
      const close = String(s.closes).replace(/^T/, '');
      const open = String(s.opens ?? '').replace(/^T/, '');
      if (close >= '19:00' || close < '05:00' || (open && close < open)) return true;
    }
  }
  return known ? false : null;
}

export const KNOWN_CHAINS = [
  'starbucks', 'peet s coffee', 'dunkin', 'tim hortons', 'krispy kreme', 'mcdonald s', 'burger king', 'wendy s', 'taco bell', 'chipotle',
  'subway', 'panera', 'shake shack', 'five guys', 'in n out', 'sweetgreen', 'cava', 'chick fil a', 'panda express', 'olive garden',
  'the cheesecake factory', 'cheesecake factory', 'p f chang s', 'applebee s', 'chili s', 'tgi fridays', 'red lobster', 'outback steakhouse',
  'buffalo wild wings', 'hard rock cafe', 'dave buster s', 'domino s', 'pizza hut', 'papa john s', 'blaze pizza', 'pf chang s',
  'barnes noble', 'urban outfitters', 'apple store', 'nordstrom', 'target', 'walmart', 'costco', 'whole foods', 'trader joe s',
  'blue bottle coffee', 'philz coffee', 'la colombe', 'joe the art of coffee', 'ippudo', 'din tai fung', 'nobu', 'tao', 'cafe nero',
  'pret a manger', 'le pain quotidien', 'paris baguette', 'tous les jours', 'gong cha', 'kung fu tea', 'boba guys', 'salt straw',
  'jeni s splendid ice creams', 'van leeuwen', 'levain bakery', 'sprinkles', 'dominique ansel', 'eataly', 'hillstone', 'topgolf', 'amc',
];
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const CHAIN_TAG = /^urn:tag:(business:place:chain|decor:qloo:chain_standard|ambience:qloo:standardized|culinary_style:qloo:fast_food|genre:place:restaurant:fast_food|category:place:fast_food_restaurant)$/;
// Note: Qloo's drive-thru tags are too noisy to use (they appear on sit-down restaurants).

/** Why a venue counts as a chain / mass-market spot, or null if it looks independent. */
export function chainReason(e) {
  const n = norm(e?.name);
  if (KNOWN_CHAINS.some((c) => n === c || n.startsWith(`${c} `))) return 'known chain';
  const tag = (e?.tags ?? []).find((t) => CHAIN_TAG.test(t.id ?? t.tag_id ?? ''));
  if (tag) return `tagged ${tag.name}`;
  // Loyalty programmes were tried as a signal and dropped: plenty of independents run stamp cards.
  return null;
}

/** Does this venue fit the leg? A generic "restaurant" primary type falls back to its other genre tags. */
export function legAccepts(leg, genre, e) {
  if (leg.accept.test(genre) && !leg.reject?.test(genre)) {
    if (genre !== 'restaurant' || !leg.reject) return true;
    // Generic restaurant under Dinner: reject only if every specific genre says bar/café.
    const specific = genreTags(e).filter((g) => g !== 'restaurant' && g.startsWith('restaurant:'));
    return !specific.length || specific.some((g) => !leg.reject.test(g));
  }
  if (genre === 'restaurant') return genreTags(e).some((g) => g !== 'restaurant' && leg.accept.test(g) && !leg.reject?.test(g));
  // Secondary evidence, e.g. an "Event venue" that Qloo also tags as a live music venue.
  if (leg.acceptTags && !leg.rejectPrimary?.test(genre)) return genreTags(e).some((g) => leg.acceptTags.test(g));
  return false;
}
// Qloo hours sometimes list only the lunch slot; a "Dinner" dining option overrides that.
const servesDinner = (e) => (e?.tags ?? []).some((t) => /^urn:tag:dining_options:place:dinner$/.test(t.id ?? t.tag_id ?? ''));
const genreTags = (e) => (e?.tags ?? []).filter((t) => t.type === 'urn:tag:genre:place').map((t) => short(t.id ?? t.tag_id));

/**
 * Filter a leg's raw Qloo results. Returns { picks, dropped } where dropped
 * records why each rejected venue was skipped (shown in the agent trace).
 */
export function vetVenues(entities, leg, { n = 3, exclude = new Set() } = {}) {
  const dropped = [];
  const counts = new Map();
  for (const e of entities ?? []) counts.set(norm(e.name), (counts.get(norm(e.name)) ?? 0) + 1);
  const keep = [];
  const seen = new Set(exclude);
  for (const e of entities ?? []) {
    const k = norm(e.name);
    if (seen.has(k) || seen.has(e.entity_id)) continue;
    seen.add(k);
    const genre = primaryGenre(e);
    const chain = chainReason(e);
    if (chain) { dropped.push({ name: e.name, why: chain }); continue; }
    if (leg.accept && genre && !legAccepts(leg, genre, e)) { dropped.push({ name: e.name, why: `${kindLabel(genre) ?? genre}, not a ${leg.label.toLowerCase()} spot` }); continue; }
    if (leg.accept && !genre) { dropped.push({ name: e.name, why: 'unknown venue type' }); continue; }
    if (leg.evening && opensEvenings(e) === false && !servesDinner(e)) { dropped.push({ name: e.name, why: 'closes before evening' }); continue; }
    keep.push({ e, rank: (counts.get(k) >= 3 ? 2 : 0) + (leg.accept.test(genre) ? 0 : 1) });
  }
  // Direct type matches first; places with 3+ branches in the same results look like local chains: keep them, but last.
  keep.sort((a, b) => a.rank - b.rank);
  return { picks: keep.slice(0, n).map((x) => x.e), dropped };
}
