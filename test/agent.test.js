import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, validateCheck, pickBest, explain, runAgent, runCheck, verdict } from '../lib/agent.js';
import { ent, fakeQloo, place, brand, tag } from './helpers.js';

test('validateRequest normalises input and enforces limits', () => {
  const v = validateRequest({ friend: '  Maya ', loves: 'Phoebe Bridgers, Lady Bird\nLady Bird', interests: 'natural wine, vinyl', budget: '9', vibe: 'nope' });
  assert.equal(v.ok, true);
  assert.deepEqual(v.value.loves, ['Phoebe Bridgers', 'Lady Bird']);
  assert.deepEqual(v.value.interests, ['natural wine', 'vinyl']);
  assert.equal(v.value.budget, 4);
  assert.equal(v.value.vibe, 'dinner');
  assert.equal(validateRequest({ loves: [] }).ok, false);
  assert.equal(validateRequest({ loves: [], interests: ['hiking'] }).ok, true, 'interests alone are enough');
  assert.equal(validateRequest({ loves: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }).ok, false);
  assert.equal(validateRequest({ loves: ['a'], interests: ['a', 'b', 'c', 'd'] }).ok, false);
  assert.equal(validateCheck({ loves: ['a'] }).ok, false, 'a check needs a candidate');
});

test('pickBest prefers exact names and places in the requested city', () => {
  const hits = [
    { entity_id: '1', name: 'Tartine Bakery Seoul', types: ['urn:entity:place'], properties: { address: 'Seoul' } },
    { entity_id: '2', name: 'Tartine Bakery', types: ['urn:entity:place'], properties: { address: '600 Guerrero St San Francisco, CA' } },
  ];
  assert.equal(pickBest('tartine bakery', hits, 'San Francisco').entity_id, '2');
  assert.equal(pickBest('x', [], 'SF'), null);
  assert.equal(pickBest('Tartine', [hits[0]], 'San Francisco'), null, 'a place in the wrong city is dropped');
  assert.equal(pickBest('natural wine', [ent('z', 'Wine Spectator', 'urn:entity:brand')], ''), null, 'a fuzzy hit must share the phrase');
});

test('explain keeps the inputs that drove a pick', () => {
  const loved = new Map([['A', 'Phoebe Bridgers'], ['B', 'Lady Bird'], ['C', 'Tartine']]);
  const e = { query: { explainability: { 'signal.interests.entities': [
    { entity_id: 'A', score: 0.9 }, { entity_id: 'B', score: 0.6 }, { entity_id: 'C', score: 0.2 }, { entity_id: 'Z', score: 1 },
  ] } } };
  assert.deepEqual(explain(e, loved).map((x) => x.name), ['Phoebe Bridgers', 'Lady Bird']);
  assert.deepEqual(explain({}, loved), []);
});

const SEARCH = {
  'Phoebe Bridgers': [ent('A', 'Phoebe Bridgers', 'urn:entity:artist')],
  'Lady Bird': [ent('B', 'Lady Bird', 'urn:entity:movie')],
  'Nonexistent Thing': [],
  'natural wine': [],
  'Lucy Dacus': [ent('ar1', 'Lucy Dacus', 'urn:entity:artist')],
};
const NATWINE = tag('urn:tag:genre:place:restaurant:natural_wine', 'Natural Wine', 'urn:tag:genre:place');
const TAGS = { 'natural wine': (opts) => (opts.parentTypes === 'urn:entity:place' ? [tag('urn:tag:decor:qloo:natural_wine_decor', 'Natural Wine Decor', 'urn:tag:decor:qloo'), NATWINE] : []) };
const EVENING = { friday: [{ opens: 'T17:00:00', closes: 'T23:00:00', closed: false }] };
const DAYTIME = { friday: [{ opens: 'T07:00:00', closes: 'T15:00:00', closed: false }] };

function scripted(params) {
  const t = params['filter.type'];
  const ex = { query: { affinity: 0.9, explainability: { 'signal.interests.entities': [{ entity_id: 'A', score: 1 }] } } };
  if (t === 'urn:tag') return { entities: [], tags: [{ tag_id: 'urn:tag:genre:media:indie', name: 'Indie' }] };
  if (t === 'urn:entity:brand') {
    return { entities: [
      brand('br0', 'Razor Co', { subtype: 'CPG', genres: ['Health & Beauty'], extra: ex }),
      brand('br1', 'Patagonia', { extra: { ...ex, tags: [...brand('x', 'x').tags, { tag_id: 'urn:tag:genre:media:indie', id: 'urn:tag:genre:media:indie', name: 'Indie' }] } }),
      brand('br2', 'Mega Mart', { pop: 0.999, extra: ex }),
      brand('br3', 'Gov Thing', { type: 'Government Brand', extra: ex }),
      brand('br4', 'Fjallraven', { extra: ex }),
      brand('br5', 'Shinola', { genres: ['Watch', 'Accessories'], extra: ex }),
    ] };
  }
  if (t === 'urn:entity:book') return { entities: [ent('bk1', 'A Book', t, { ...ex, tags: [tag('urn:tag:genre:media:fiction', 'Fiction')] })] };
  // Artist results include an input entity, which must be filtered out
  if (t === 'urn:entity:artist') return { entities: [ent('A', 'Phoebe Bridgers', t, ex), ent('ar1', 'Lucy Dacus', t, ex)] };
  if (t === 'urn:entity:place') {
    const tags = params['filter.tags'];
    if (tags.includes('restaurant:cocktail_bar') && !tags.endsWith('restaurant')) {
      return { entities: [
        place('d1', 'Bowling Club', 'bowling_alley', { hours: EVENING, extra: ex }),
        place('d2', 'Wine Bar X', 'restaurant:wine_bar', { hours: EVENING, extra: ex, tags: [NATWINE] }),
        place('d3', 'Bar Y', 'restaurant:cocktail_bar', { hours: EVENING, extra: ex }),
      ] };
    }
    // Simulate an empty first attempt when price-capped, forcing the agent to relax
    if (params['filter.price_level.max']) return { entities: [] };
    return { entities: [
      place('p0', 'Speakeasy', 'restaurant:cocktail_bar', { hours: EVENING, extra: ex }),
      place('p1', 'Bistro X', 'restaurant:french', { hours: EVENING, extra: { ...ex }, props: { price_level: 2 } }),
      place('p2', 'Morning Cafe', 'restaurant:cafe', { hours: DAYTIME, extra: ex }),
      place('p3', 'Starbucks Coffee Company', 'restaurant:coffee_shop', { extra: ex }),
      place('p4', 'Lunch Only', 'restaurant:italian', { hours: DAYTIME, extra: ex }),
      place('p5', 'Trattoria Z', 'restaurant:italian', { extra: ex }),
    ] };
  }
  return { entities: [] };
}

test('runAgent resolves loves and interests, vets gifts and venues, and relaxes', async () => {
  const qloo = fakeQloo({ search: SEARCH, insights: scripted, tags: TAGS });
  const { value } = validateRequest({ friend: 'Maya', loves: ['Phoebe Bridgers', 'Lady Bird', 'Nonexistent Thing'], interests: ['natural wine'], city: 'San Francisco', budget: 2 });
  const plan = await runAgent(value, { qloo });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.loved.map((l) => l.name), ['Phoebe Bridgers', 'Lady Bird']);
  assert.match(plan.warnings.join(' '), /Nonexistent Thing/);
  assert.deepEqual(plan.interests, [{ input: 'natural wine', place: 'Natural Wine', gift: null }], 'picks the genre tag, not the decor tag');
  assert.deepEqual(plan.profile.map((t) => t.name), ['Indie']);

  // Gifts: consumables, mass-market and government brands are dropped
  const brands = plan.gifts.brands.map((b) => b.name);
  assert.ok(brands.includes('Patagonia') && brands.includes('Fjallraven') && brands.includes('Shinola'));
  for (const bad of ['Razor Co', 'Mega Mart', 'Gov Thing']) assert.ok(!brands.includes(bad), `${bad} should be vetted out`);
  const pata = plan.gifts.brands.find((b) => b.name === 'Patagonia');
  assert.deepEqual(pata.because.map((b) => b.name), ['Phoebe Bridgers']);
  assert.deepEqual(pata.sharedTags, ['Indie']);
  assert.equal(pata.idea, 'Something from Patagonia');
  assert.deepEqual(plan.gifts.artists.map((a) => a.name), ['Lucy Dacus'], 'input entities are never recommended back');

  // Dinner: no bar, no daytime-only spot, no chain; types are labelled
  const dinner = plan.outing.main.picks.map((p) => p.name);
  assert.deepEqual(dinner, ['Bistro X', 'Trattoria Z']);
  assert.equal(plan.outing.main.picks[0].kind, 'French restaurant');
  // Drinks: bowling alley vetted out; the natural-wine interest is surfaced
  assert.deepEqual(plan.outing.after.picks.map((p) => p.name), ['Wine Bar X', 'Bar Y']);
  assert.deepEqual(plan.outing.after.picks[0].into, ['natural wine']);

  const dinnerTrace = plan.trace.find((t) => t.step === 'outing: dinner (relaxed)');
  assert.ok(dinnerTrace?.note, 'agent records its relaxation');
  assert.ok(dinnerTrace.dropped.some((d) => /Speakeasy: Cocktail bar, not a dinner spot/.test(d)));
  assert.ok(dinnerTrace.dropped.some((d) => /Starbucks.*known chain/.test(d)));
  assert.ok(dinnerTrace.dropped.some((d) => /Lunch Only: closes before evening/.test(d)));

  const insightCalls = qloo.calls.filter((c) => c.kind === 'insights');
  for (const c of insightCalls) {
    if (c.params['filter.type'] === 'urn:tag') continue;
    assert.equal(c.params['feature.explainability'], true);
    assert.equal(c.params['filter.exclude.entities'], 'A,B');
  }
  const placeCall = insightCalls.find((c) => c.params['filter.type'] === 'urn:entity:place');
  assert.equal(placeCall.params['filter.location.query'], 'San Francisco');
  assert.equal(placeCall.params['signal.interests.tags'], NATWINE.id);
  assert.match(placeCall.params['filter.exclude.tags'], /coffee_shop/);
  const brandCall = insightCalls.find((c) => c.params['filter.type'] === 'urn:entity:brand');
  assert.match(brandCall.params['filter.tags'], /genre:brand:fashion/);
  assert.equal(brandCall.params['filter.popularity.max'], 0.98);
});

test('runAgent skips the outing when no city is given', async () => {
  const qloo = fakeQloo({ search: SEARCH, insights: scripted });
  const { value } = validateRequest({ loves: ['Lady Bird'] });
  const plan = await runAgent(value, { qloo });
  assert.equal(plan.ok, true);
  assert.equal(plan.outing.main, null);
  assert.ok(!qloo.calls.some((c) => c.params?.['filter.type'] === 'urn:entity:place'));
  assert.match(plan.warnings.join(' '), /No city/);
});

test('runAgent fails gracefully when nothing resolves', async () => {
  const qloo = fakeQloo({ search: SEARCH, insights: scripted });
  const { value } = validateRequest({ loves: ['Nonexistent Thing'] });
  const plan = await runAgent(value, { qloo });
  assert.equal(plan.ok, false);
  assert.match(plan.error, /None of those loves/);
});

test('an unresolvable love falls back to an interest tag', async () => {
  const qloo = fakeQloo({ search: SEARCH, insights: scripted, tags: TAGS });
  const { value } = validateRequest({ loves: ['natural wine'], city: 'San Francisco' });
  const plan = await runAgent(value, { qloo });
  assert.equal(plan.ok, true);
  assert.equal(plan.loved.length, 0);
  assert.equal(plan.interests[0].input, 'natural wine');
  assert.match(plan.warnings.join(' '), /read it as an interest/);
});

test('surprise mode lowers the popularity cap on gift calls', async () => {
  const qloo = fakeQloo({ search: SEARCH, insights: scripted });
  const { value } = validateRequest({ loves: ['Lady Bird'], surprise: true });
  await runAgent(value, { qloo });
  const brandCall = qloo.calls.find((c) => c.params?.['filter.type'] === 'urn:entity:brand');
  assert.equal(brandCall.params['filter.popularity.max'], 0.93);
  const book = qloo.calls.find((c) => c.params?.['filter.type'] === 'urn:entity:book');
  assert.equal(book.params['filter.popularity.max'], 0.9);
  assert.equal(book.params['signal.interests.entities'], 'B', 'books are driven by media loves');
});

test('verdict maps affinity to plain language', () => {
  assert.equal(verdict(0.97).level, 'great');
  assert.equal(verdict(0.87).level, 'good');
  assert.equal(verdict(0.8).level, 'meh');
  assert.equal(verdict(0.7).level, 'poor');
  assert.equal(verdict(null).level, 'unknown');
  assert.ok(verdict(0.9, 0.9).note);
});

test('runCheck scores a candidate with filter.results.entities and suggests alternatives', async () => {
  const qloo = fakeQloo({
    search: SEARCH,
    insights: (params) => {
      if (params['filter.results.entities']) return { entities: [ent('ar1', 'Lucy Dacus', 'urn:entity:artist', { query: { affinity: 0.95, explainability: { 'signal.interests.entities': [{ entity_id: 'A', score: 0.8 }] } } })] };
      return { entities: [ent('ar2', 'Julien Baker', 'urn:entity:artist', { query: { affinity: 0.94 } })] };
    },
  });
  const { value } = validateCheck({ loves: ['Phoebe Bridgers', 'Lady Bird'], candidate: 'Lucy Dacus' });
  const r = await runCheck(value, { qloo });
  assert.equal(r.ok, true);
  assert.equal(r.candidate.name, 'Lucy Dacus');
  assert.equal(r.affinity, 0.95);
  assert.equal(r.verdict.level, 'great');
  assert.deepEqual(r.because.map((b) => b.name), ['Phoebe Bridgers']);
  assert.equal(r.alternatives[0].name, 'Julien Baker');
  const score = qloo.calls.find((c) => c.params?.['filter.results.entities']);
  assert.equal(score.params['filter.type'], 'urn:entity:artist');
  assert.equal(score.params['signal.interests.entities'], 'A,B');
});

test('runCheck handles unknown candidates and things they already love', async () => {
  const qloo = fakeQloo({ search: SEARCH, insights: () => ({ entities: [] }) });
  const miss = await runCheck(validateCheck({ loves: ['Lady Bird'], candidate: 'Nonexistent Thing' }).value, { qloo });
  assert.equal(miss.ok, false);
  assert.match(miss.error, /Couldn't find/);
  const same = await runCheck(validateCheck({ loves: ['Lady Bird'], candidate: 'Lady Bird' }).value, { qloo });
  assert.equal(same.verdict.label, 'They already love it');
});
