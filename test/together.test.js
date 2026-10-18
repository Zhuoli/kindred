import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { validateTogether, attribute, sideCounts, fairPick, balanceOf, becauseBoth, commonTags, runTogether } from '../lib/together.js';
import { makePlanHandler, resetRateLimit, isExample } from '../lib/handler.js';
import { createMemoryStore, createTieredCache } from '../lib/cache.js';
import { EXAMPLES } from '../lib/examples.js';
import { ent, fakeQloo, place, mockRes } from './helpers.js';

beforeEach(() => resetRateLimit());

const owners = new Map([['A', new Set(['them'])], ['B', new Set(['them'])], ['C', new Set(['you'])], ['D', new Set(['you', 'them'])]]);
const names = new Map([['A', 'Phoebe Bridgers'], ['B', 'Lady Bird'], ['C', 'The Bear'], ['D', 'Radiohead']]);
const withEx = (id, name, type, ex, affinity = 0.9) => ent(id, name, type, { query: { affinity, explainability: { 'signal.interests.entities': ex.map(([entity_id, score]) => ({ entity_id, score })) } } });

test('validateTogether needs specific loves from both people', () => {
  const ok = validateTogether({ mode: 'us', friend: 'Maya', loves: ['Lady Bird'], yourLoves: 'The Bear, Radiohead', you: '  Sam ' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.mode, 'us');
  assert.equal(ok.value.you, 'Sam');
  assert.deepEqual(ok.value.yourLoves, ['The Bear', 'Radiohead']);
  assert.equal(validateTogether({ loves: ['Lady Bird'] }).ok, false, 'your own loves are required');
  assert.match(validateTogether({ loves: [], interests: ['jazz'], yourLoves: ['x'] }).errors.join(' '), /specific thing your friend loves/);
  assert.equal(validateTogether({ loves: ['a'], yourLoves: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }).ok, false);
  assert.equal(validateTogether({ loves: ['a'], yourLoves: ['b'], yourInterests: ['1', '2', '3', '4'] }).ok, false);
});

test('attribute averages each side over its own loves and labels the lean', () => {
  const c = sideCounts(owners);
  assert.deepEqual(c, { them: 3, you: 2 }, 'a shared love counts for both');
  // Them: A .3 + B .3 + D .1 = .7 / 3 = .233; you: C .3 + D .1 = .4 / 2 = .2 -> share .54 -> both
  const both = attribute(withEx('x', 'x', 'urn:entity:movie', [['A', 0.3], ['B', 0.3], ['C', 0.3], ['D', 0.1]]), owners);
  assert.equal(both.lean, 'both');
  const them = attribute(withEx('y', 'y', 'urn:entity:movie', [['A', 0.6], ['B', 0.3], ['C', 0.05]]), owners);
  assert.equal(them.lean, 'them');
  assert.ok(them.share > 0.58);
  const you = attribute(withEx('z', 'z', 'urn:entity:movie', [['C', 0.8], ['A', 0.1]]), owners);
  assert.equal(you.lean, 'you');
  assert.equal(attribute(ent('n', 'n', 'urn:entity:movie'), owners).lean, 'unknown');
  assert.equal(attribute(withEx('q', 'q', 'urn:entity:movie', [['ZZZ', 1]]), owners).share, null, 'unknown entities are ignored');
});

test('becauseBoth names the loves behind a pick and whose they are', () => {
  const b = becauseBoth(withEx('x', 'x', 'urn:entity:movie', [['A', 0.4], ['C', 0.35], ['D', 0.3], ['B', 0.05]]), owners, names);
  assert.deepEqual(b.map((x) => [x.name, x.who]), [['Phoebe Bridgers', 'them'], ['The Bear', 'you'], ['Radiohead', 'both']]);
});

test('fairPick keeps either person from dominating while alternatives remain', () => {
  const mk = (id, lean) => ({ e: { entity_id: id }, attr: { lean } });
  const ranked = [mk(1, 'them'), mk(2, 'them'), mk(3, 'them'), mk(4, 'you'), mk(5, 'both'), mk(6, 'them')];
  const picked = fairPick(ranked, 4).map((r) => r.e.entity_id);
  assert.deepEqual(picked, [1, 4, 2, 5], 'a second pick for them only after one for you');
  assert.deepEqual(fairPick([mk(1, 'them'), mk(2, 'them')], 2).map((r) => r.e.entity_id), [1, 2], 'falls back when nothing else is left');
  assert.deepEqual(balanceOf([{ lean: 'both' }, { lean: 'them' }, { lean: 'unknown' }]), { both: 1, them: 1, you: 0 });
});

test('commonTags drops uninformative tags and keeps the strongest first', () => {
  const t = commonTags([
    { tag_id: 'urn:tag:region:qloo:united_states', name: 'United States', query: { score: 0.9 } },
    { tag_id: 'urn:tag:audience:qloo:loyal', name: 'Loyal', query: { score: 0.7 } },
    { tag_id: 'urn:tag:genre:music:folk', name: 'Folk', query: { score: 0.8 } },
    { tag_id: 'urn:tag:genre:media:drama', name: 'Drama', query: { score: 0.7 } },
    { tag_id: 'urn:tag:keyword:qloo:media_tie_in', name: 'Media Tie In' },
  ]).map((x) => x.name);
  assert.deepEqual(t, ['Folk', 'Drama', 'Loyal']);
});

const SEARCH = {
  'Phoebe Bridgers': [ent('A', 'Phoebe Bridgers', 'urn:entity:artist')],
  'Lady Bird': [ent('B', 'Lady Bird', 'urn:entity:movie')],
  'The Bear': [ent('C', 'The Bear', 'urn:entity:tv_show')],
  Radiohead: [ent('D', 'Radiohead', 'urn:entity:artist')],
  Nobody: [],
};
const EVENING = { friday: [{ opens: 'T17:00:00', closes: 'T23:00:00', closed: false }] };
function scripted(params) {
  const t = params['filter.type'];
  if (t === 'urn:entity:movie') {
    return { entities: [
      withEx('m0', 'Lady Bird', t, [['A', 1]], 0.99), // an input, must never come back
      withEx('m1', 'Her Movie', t, [['A', 0.6], ['B', 0.5], ['C', 0.05]], 0.95),
      withEx('m2', 'Her Other Movie', t, [['A', 0.6], ['B', 0.5]], 0.94),
      withEx('m3', 'Our Movie', t, [['A', 0.3], ['B', 0.3], ['C', 0.3], ['D', 0.25]], 0.9),
      withEx('m4', 'His Movie', t, [['C', 0.7], ['D', 0.5]], 0.89),
    ] };
  }
  if (t === 'urn:entity:place') {
    const ex = { query: { affinity: 0.9, explainability: { 'signal.interests.entities': [{ entity_id: 'A', score: 0.3 }, { entity_id: 'C', score: 0.3 }] } } };
    return { entities: [
      place('p1', 'Bistro X', 'restaurant:french', { hours: EVENING, extra: ex }),
      place('p2', 'Wine Bar X', 'restaurant:wine_bar', { hours: EVENING, extra: ex }),
    ] };
  }
  return { entities: [] };
}
const COMPARE = () => ({
  shared: [{ tag_id: 'urn:tag:genre:music:indie', name: 'Indie', query: { score: 0.8 } }, { tag_id: 'urn:tag:region:qloo:us', name: 'United States', query: { score: 0.9 } }],
  a: [{ tag_id: 'urn:tag:theme:qloo:heartbreak', name: 'Heartbreak' }],
  b: [{ tag_id: 'urn:tag:style:qloo:realistic', name: 'Realistic' }],
});

test('runTogether blends both tastes, attributes picks, and keeps the plan fair', async () => {
  const qloo = fakeQloo({ search: SEARCH, insights: scripted, compare: COMPARE });
  const events = [];
  const { value } = validateTogether({ mode: 'us', friend: 'Maya', loves: ['Phoebe Bridgers', 'Lady Bird'], yourLoves: ['The Bear', 'Radiohead'], city: 'San Francisco' });
  const plan = await runTogether(value, { qloo, onEvent: (e) => events.push(e) });
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'us');
  assert.deepEqual(plan.loved.them.map((l) => l.name), ['Phoebe Bridgers', 'Lady Bird']);
  assert.deepEqual(plan.loved.you.map((l) => l.name), ['The Bear', 'Radiohead']);
  assert.deepEqual(plan.common.shared.map((t) => t.name), ['Indie'], 'a shared country is dropped');
  assert.deepEqual(plan.common.them, ['Heartbreak']);

  const cmp = qloo.calls.find((c) => c.kind === 'compare');
  assert.equal(cmp.a, 'A,B');
  assert.equal(cmp.b, 'C,D');
  const movie = qloo.calls.find((c) => c.params?.['filter.type'] === 'urn:entity:movie');
  assert.equal(movie.params['signal.interests.entities'], 'A,B,C,D', 'one call signalled by both people');
  assert.equal(movie.params['feature.explainability'], true);

  const films = plan.together.films;
  assert.ok(!films.some((f) => f.name === 'Lady Bird'), 'inputs are never recommended back');
  assert.equal(films[0].name, 'Our Movie', 'the pick that serves both ranks first');
  assert.equal(films[0].lean, 'both');
  const leans = films.map((f) => f.lean);
  assert.ok(leans.includes('you'), 'the other person gets a pick before a second one-sided pick');
  assert.ok(leans.filter((l) => l === 'them').length <= 1);
  assert.ok(films[0].because.some((b) => b.who === 'you') && films[0].because.some((b) => b.who === 'them'));
  assert.equal(plan.outing.main.picks[0].name, 'Bistro X');
  assert.equal(plan.balance.both + plan.balance.them + plan.balance.you, films.length + plan.outing.main.picks.length + plan.outing.after.picks.length);

  // Live events: phases in order, every call starts then finishes
  const phases = events.filter((e) => e.type === 'phase').map((e) => e.phase);
  assert.deepEqual(phases, ['resolve', 'compare', 'plan', 'compose']);
  const starts = events.filter((e) => e.type === 'start').length;
  const steps = events.filter((e) => e.type === 'step');
  assert.equal(starts, steps.length);
  assert.equal(steps.length, plan.trace.length);
  assert.ok(steps.some((s) => s.step === 'outing: dinner' && s.kept != null), 'insights steps arrive after vetting');
});

test('runTogether fails clearly when one side resolves nothing', async () => {
  const qloo = fakeQloo({ search: SEARCH, insights: scripted, compare: COMPARE });
  const r = await runTogether(validateTogether({ friend: 'Maya', loves: ['Lady Bird'], yourLoves: ['Nobody'] }).value, { qloo });
  assert.equal(r.ok, false);
  assert.match(r.error, /for you/);
  assert.ok(!qloo.calls.some((c) => c.kind === 'compare'));
});

const freshCache = () => createTieredCache({ memory: createMemoryStore() });
const req = (body, accept) => ({ method: 'POST', body, headers: { 'x-forwarded-for': '5.5.5.5', ...(accept ? { accept } : {}) } });

test('plan handler routes us mode and streams live steps as NDJSON', async () => {
  const qloo = fakeQloo({ search: SEARCH, insights: scripted, compare: COMPARE });
  const h = makePlanHandler({ clientFactory: () => qloo, cache: freshCache(), guard: () => false });
  const body = { mode: 'us', friend: 'Maya', loves: ['Lady Bird'], yourLoves: ['The Bear'], city: 'San Francisco' };
  const res = mockRes();
  await h(req(body, 'application/x-ndjson'), res);
  assert.match(res.headers['content-type'], /x-ndjson/);
  const lines = res.lines();
  assert.equal(lines[0].type, 'phase');
  const last = lines.at(-1);
  assert.equal(last.type, 'result');
  assert.equal(last.status, 200);
  assert.equal(last.result.mode, 'us');
  assert.equal(last.result.cache.hit, false);
  assert.ok(lines.filter((l) => l.type === 'step').length >= 3);
  assert.ok(res.ended);

  // Same request again: one result line from cache, no Qloo calls
  const n = qloo.calls.length;
  const again = mockRes();
  await h(req(body, 'application/x-ndjson'), again);
  const l2 = again.lines();
  assert.equal(l2.length, 1);
  assert.equal(l2[0].result.cache.hit, true);
  assert.equal(qloo.calls.length, n);

  // Plain JSON clients still get JSON; validation errors are never streamed
  const plain = mockRes();
  await h(req({ mode: 'us', loves: ['Lady Bird'] }, 'application/x-ndjson'), plain);
  assert.equal(plain.statusCode, 400);
  assert.match(plain.json().error, /you love/);
});

test('streamed failures stay generic', async () => {
  const broken = { search: async () => { throw new Error('boom secret detail'); }, tags: async () => [] };
  const h = makePlanHandler({ clientFactory: () => broken, cache: freshCache(), guard: () => false });
  const res = mockRes();
  const orig = console.error; console.error = () => {};
  try { await h(req({ loves: ['x'] }, 'application/x-ndjson'), res); } finally { console.error = orig; }
  const last = res.lines().at(-1);
  assert.equal(last.status, 500);
  assert.ok(!res.body.includes('boom secret detail'));
});

test('"us" examples are recognised and bypass the quota guard', () => {
  const us = EXAMPLES.filter((e) => e.input.mode === 'us');
  assert.ok(us.length >= 2);
  for (const e of us) {
    const v = validateTogether(e.input);
    assert.equal(v.ok, true, e.id);
    assert.equal(isExample(v.value), true, e.id);
  }
});
