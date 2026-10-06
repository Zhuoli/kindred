import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheKey, createFileStore, createMemoryStore, createTieredCache, persistentStoreFromEnv } from '../lib/cache.js';
import { cachedRun, cacheable, quotaExhausted } from '../lib/plan-cache.js';

test('cacheKey is stable, namespaced and does not leak inputs', () => {
  const a = cacheKey('plan', { loves: ['x'] });
  assert.equal(a, cacheKey('plan', { loves: ['x'] }));
  assert.notEqual(a, cacheKey('plan', { loves: ['y'] }));
  assert.match(a, /^v\d+\/plan\/[0-9a-f]{32}$/);
});

test('tiered cache: memory first, then persistent, with TTL', async () => {
  let t = 1000;
  const persistent = createMemoryStore();
  persistent.kind = 'test';
  const c = createTieredCache({ persistent, ttlMs: 100, now: () => t });
  await c.set('k', { a: 1 });
  assert.deepEqual(await c.get('k'), { value: { a: 1 }, from: 'memory' });
  const fresh = createTieredCache({ persistent, ttlMs: 100, now: () => t });
  assert.deepEqual(await fresh.get('k'), { value: { a: 1 }, from: 'test' }, 'a new instance reads the persistent store');
  t += 500;
  assert.equal(await fresh.get('k'), undefined, 'expired entries are ignored');
});

test('a failing persistent store never breaks reads or writes', async () => {
  const broken = { kind: 'broken', get: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); } };
  const logs = [];
  const c = createTieredCache({ persistent: broken, memory: createMemoryStore(), log: (m) => logs.push(m) });
  await c.set('k', 1);
  assert.equal((await c.get('k')).value, 1);
  assert.equal(await createTieredCache({ persistent: broken, log: (m) => logs.push(m) }).get('k'), undefined);
  assert.ok(logs.length >= 2);
});

test('file store round-trips JSON in a private folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kindred-'));
  try {
    const s = createFileStore(dir);
    await s.set('v2/plan/abc', { t: 1, v: { ok: true } });
    assert.deepEqual(await s.get('v2/plan/abc'), { t: 1, v: { ok: true } });
    assert.equal(await s.get('missing'), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('persistentStoreFromEnv prefers private Blob, then a local folder', () => {
  assert.equal(persistentStoreFromEnv({ BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_fake' }).kind, 'blob');
  assert.equal(persistentStoreFromEnv({ KINDRED_CACHE_DIR: '/tmp/x' }).kind, 'file');
  assert.equal(persistentStoreFromEnv({}), null);
});

test('cachedRun serves repeats from cache and only caches clean results', async () => {
  const cache = createTieredCache({ memory: createMemoryStore() });
  let runs = 0;
  const run = async () => { runs += 1; return { ok: true, trace: [{ step: 'x' }, { step: 'y' }] }; };
  const first = await cachedRun({ kind: 'plan', value: { a: 1 }, run, cache, guard: () => false });
  const second = await cachedRun({ kind: 'plan', value: { a: 1 }, run, cache, guard: () => false });
  assert.equal(runs, 1);
  assert.equal(first.cache.hit, false);
  assert.deepEqual(second.cache, { hit: true, from: 'memory', savedCalls: 2 });
  assert.equal(cacheable({ ok: true, trace: [{ error: 'Qloo 500' }] }), false);
  assert.equal(cacheable({ ok: false, trace: [] }), false);
});

test('quota guard blocks fresh work below the reserve but still serves cache', async () => {
  assert.equal(quotaExhausted({ q: { remaining: null }, reserve: 1000 }), false, 'unknown quota does not block');
  assert.equal(quotaExhausted({ q: { remaining: 999 }, reserve: 1000 }), true);
  assert.equal(quotaExhausted({ q: { remaining: 5000 }, reserve: 1000 }), false);
  const cache = createTieredCache({ memory: createMemoryStore() });
  await cachedRun({ kind: 'plan', value: { b: 1 }, run: async () => ({ ok: true, trace: [] }), cache, guard: () => false });
  const blocked = await cachedRun({ kind: 'plan', value: { b: 2 }, run: async () => assert.fail('must not run'), cache, guard: () => true });
  assert.equal(blocked.status, 503);
  const served = await cachedRun({ kind: 'plan', value: { b: 1 }, run: async () => assert.fail('must not run'), cache, guard: () => true });
  assert.equal(served.cache.hit, true);
});
