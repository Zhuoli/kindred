import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, createQlooClient, createThrottle, QlooError, clearCache } from '../lib/qloo.js';

const FAKE_KEY = 'test-key-not-real';

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  fn.calls = calls;
  return fn;
}
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

test('buildQuery skips empty values and joins arrays', () => {
  assert.equal(buildQuery({ a: 'x', b: '', c: undefined, d: ['1', '2'], e: 0 }), 'a=x&d=1%2C2&e=0');
});

test('requires an API key', () => {
  assert.throws(() => createQlooClient({ apiKey: '' }), QlooError);
});

test('sends key only in X-Api-Key header, against the hackathon base URL, via GET', async () => {
  clearCache();
  const f = fakeFetch(() => json(200, { results: { entities: [{ name: 'A' }] } }));
  const q = createQlooClient({ apiKey: FAKE_KEY, baseUrl: 'https://hackathon.api.qloo.com/', fetchImpl: f, useCache: false });
  const r = await q.insights({ 'filter.type': 'urn:entity:brand', 'signal.interests.entities': 'X,Y' });
  assert.equal(r.entities.length, 1);
  const { url, init } = f.calls[0];
  assert.ok(url.startsWith('https://hackathon.api.qloo.com/v2/insights?'));
  assert.ok(!url.includes(FAKE_KEY), 'key must not be in the URL');
  assert.equal(init.headers['X-Api-Key'], FAKE_KEY);
  assert.equal(init.method, undefined, 'insights must be a GET');
  assert.ok(url.includes('filter.type=urn%3Aentity%3Abrand'));
});

test('insights requires filter.type', async () => {
  const q = createQlooClient({ apiKey: FAKE_KEY, fetchImpl: fakeFetch(() => json(200, {})) });
  await assert.rejects(() => q.insights({}), /filter.type/);
});

test('maps HTTP errors to QlooError without leaking the key', async () => {
  clearCache();
  const f = fakeFetch(() => json(403, { errors: [{ message: 'You do not have permission to access urn:entity:music' }] }));
  const q = createQlooClient({ apiKey: FAKE_KEY, fetchImpl: f, useCache: false });
  await assert.rejects(() => q.insights({ 'filter.type': 'urn:entity:music' }), (err) => {
    assert.ok(err instanceof QlooError);
    assert.equal(err.status, 403);
    assert.ok(!err.message.includes(FAKE_KEY));
    return true;
  });
});

test('search returns the results array; caches identical requests', async () => {
  clearCache();
  const f = fakeFetch(() => json(200, { results: [{ name: 'Radiohead', entity_id: 'R' }] }));
  const q = createQlooClient({ apiKey: FAKE_KEY, fetchImpl: f });
  const a = await q.search('radiohead', { types: 'urn:entity:artist' });
  const b = await q.search('radiohead', { types: 'urn:entity:artist' });
  assert.equal(a[0].entity_id, 'R');
  assert.deepEqual(a, b);
  assert.equal(f.calls.length, 1);
});

test('retries 429 with backoff, then succeeds', async () => {
  clearCache();
  let n = 0;
  const f = fakeFetch(() => (++n < 3 ? json(429, { error: 'rate' }) : json(200, { results: [{ name: 'ok' }] })));
  const slept = [];
  const q = createQlooClient({ apiKey: FAKE_KEY, fetchImpl: f, useCache: false, throttle: async () => {}, sleep: async (ms) => { slept.push(ms); } });
  const r = await q.search('x');
  assert.equal(r[0].name, 'ok');
  assert.equal(f.calls.length, 3);
  assert.equal(slept.length, 2);
  assert.ok(slept[1] > slept[0]);
});

test('gives up after maxRetries 429s', async () => {
  clearCache();
  const f = fakeFetch(() => json(429, {}));
  const q = createQlooClient({ apiKey: FAKE_KEY, fetchImpl: f, useCache: false, throttle: async () => {}, sleep: async () => {}, maxRetries: 2 });
  await assert.rejects(() => q.search('x'), (e) => e.status === 429);
  assert.equal(f.calls.length, 3);
});

test('throttle spaces calls to stay under the per-second limit', async () => {
  let t = 0;
  const waits = [];
  const slot = createThrottle({ perSecond: 4, now: () => t, sleep: async (ms) => { waits.push(ms); } });
  await slot(); await slot(); await slot();
  assert.deepEqual(waits, [250, 500]);
});

test('noteQuota records the monthly counter from response headers', async () => {
  const { noteQuota, quota } = await import('../lib/qloo.js');
  noteQuota(new Headers({ 'x-month-ratelimit-remaining': '9876', 'x-month-ratelimit-limit': '10000' }), 42);
  assert.equal(quota.remaining, 9876);
  assert.equal(quota.limit, 10000);
  assert.equal(quota.at, 42);
  noteQuota(undefined);
  assert.equal(quota.remaining, 9876, 'missing headers leave the reading alone');
});
