import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makePlanHandler, makeCheckHandler, examplesHandler, healthHandler, resetRateLimit, isExample } from '../lib/handler.js';
import { validateRequest } from '../lib/agent.js';
import { EXAMPLES } from '../lib/examples.js';
import { createMemoryStore, createTieredCache } from '../lib/cache.js';
import { QlooError } from '../lib/qloo.js';
import { ent, fakeQloo, mockRes } from './helpers.js';

beforeEach(() => resetRateLimit());
const req = (body, method = 'POST', ip = '1.2.3.4') => ({ method, body, headers: { 'x-forwarded-for': ip } });
const freshCache = () => createTieredCache({ memory: createMemoryStore() });
const ladyBird = () => fakeQloo({ search: { 'Lady Bird': [ent('B', 'Lady Bird', 'urn:entity:movie')] }, insights: () => ({ entities: [] }) });

test('rejects non-POST', async () => {
  const res = mockRes();
  await makePlanHandler({ clientFactory: () => fakeQloo(), cache: freshCache() })(req(null, 'GET'), res);
  assert.equal(res.statusCode, 405);
});

test('400 on invalid input', async () => {
  const res = mockRes();
  await makePlanHandler({ clientFactory: () => fakeQloo(), cache: freshCache() })(req({ loves: [] }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().ok, false);
});

test('returns a plan, then serves the identical request from cache with zero Qloo calls', async () => {
  const qloo = ladyBird();
  const h = makePlanHandler({ clientFactory: () => qloo, cache: freshCache(), guard: () => false });
  const res = mockRes();
  await h(req({ loves: ['Lady Bird'] }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().loved[0].name, 'Lady Bird');
  assert.equal(res.json().cache.hit, false);
  assert.equal(res.headers['cache-control'], 'no-store');
  const callsAfterFirst = qloo.calls.length;
  const again = mockRes();
  await h(req({ loves: ['Lady Bird'] }), again);
  assert.equal(again.json().cache.hit, true);
  assert.equal(qloo.calls.length, callsAfterFirst, 'cache hit makes no Qloo calls');
});

test('quota guard returns 503 for new plans but examples still run', async () => {
  const h = makePlanHandler({ clientFactory: () => ladyBird(), cache: freshCache(), guard: () => true });
  const res = mockRes();
  await h(req({ loves: ['Lady Bird'] }), res);
  assert.equal(res.statusCode, 503);
  assert.match(res.json().error, /pacing/);
  assert.equal(isExample(validateRequest(EXAMPLES[0].input).value), true);
  const ex = mockRes();
  await h(req(EXAMPLES[0].input), ex);
  assert.notEqual(ex.statusCode, 503, 'examples bypass the guard');
  assert.equal(ex.json().example, true);
});

test('check endpoint validates and scores', async () => {
  const qloo = fakeQloo({
    search: { 'Lady Bird': [ent('B', 'Lady Bird', 'urn:entity:movie')], Frances: [ent('F', 'Frances Ha', 'urn:entity:movie')] },
    insights: () => ({ entities: [ent('F', 'Frances Ha', 'urn:entity:movie', { query: { affinity: 0.93 } })] }),
  });
  const h = makeCheckHandler({ clientFactory: () => qloo, cache: freshCache(), guard: () => false });
  const bad = mockRes();
  await h(req({ loves: ['Lady Bird'] }), bad);
  assert.equal(bad.statusCode, 400);
  const res = mockRes();
  await h(req({ loves: ['Lady Bird'], candidate: 'Frances' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().verdict.level, 'great');
});

test('auth failures become a generic 502 with no internals', async () => {
  const secret = 'super-secret-key-value';
  const broken = { search: async () => { throw new QlooError('Qloo /search returned 401', { status: 401 }); }, tags: async () => [] };
  const res = mockRes();
  const orig = console.error; console.error = () => {};
  try { await makePlanHandler({ clientFactory: () => broken, cache: freshCache(), guard: () => false })(req({ loves: ['x'] }), res); } finally { console.error = orig; }
  assert.equal(res.statusCode, 502);
  assert.ok(!res.body.includes(secret) && !res.body.includes('401'));
});

test('rate limits bursts per IP', async () => {
  const h = makePlanHandler({ clientFactory: () => fakeQloo(), cache: freshCache() });
  let last;
  for (let i = 0; i < 16; i++) { last = mockRes(); await h(req({ loves: [] }, 'POST', '9.9.9.9'), last); }
  assert.equal(last.statusCode, 429);
});

test('examples and health endpoints expose no secrets', async () => {
  const ex = mockRes();
  examplesHandler(req(null, 'GET'), ex);
  const list = ex.json().examples;
  assert.ok(list.length >= 4);
  for (const e of list) assert.equal(validateRequest(e.input).ok, true, `${e.id} is a valid request`);
  const h = mockRes();
  healthHandler(req(null, 'GET'), h);
  const body = h.json();
  assert.equal(body.ok, true);
  assert.ok('quota' in body);
  if (process.env.QLOO_API_KEY) assert.ok(!h.body.includes(process.env.QLOO_API_KEY));
});
