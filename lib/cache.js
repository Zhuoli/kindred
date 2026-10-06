// Private, persistent server-side cache. Qloo allows private caching but its
// data must never land in the public repo, so stores live outside git:
//   - BlobStore: a *private* Vercel Blob store (production; BLOB_READ_WRITE_TOKEN)
//   - FileStore: a gitignored local folder (development; KINDRED_CACHE_DIR)
//   - MemoryStore: per-instance fallback and tests
// Every store is best-effort: a failing cache never breaks a plan.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CACHE_VERSION = 'v2';
const DAY = 24 * 60 * 60 * 1000;

export function cacheKey(namespace, value) {
  const h = createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
  return `${CACHE_VERSION}/${namespace}/${h}`;
}

export function createMemoryStore({ max = 500 } = {}) {
  const m = new Map();
  return {
    kind: 'memory',
    async get(key) { return m.has(key) ? m.get(key) : undefined; },
    async set(key, value) {
      if (m.size >= max) m.delete(m.keys().next().value);
      m.set(key, value);
    },
    size: () => m.size,
  };
}

export function createFileStore(dir) {
  const path = (key) => join(dir, `${key.replace(/[^a-zA-Z0-9_-]+/g, '_')}.json`);
  return {
    kind: 'file',
    async get(key) {
      try { return JSON.parse(await readFile(path(key), 'utf8')); } catch { return undefined; }
    },
    async set(key, value) {
      await mkdir(dir, { recursive: true });
      await writeFile(path(key), JSON.stringify(value));
    },
  };
}

export function createBlobStore({ token = process.env.BLOB_READ_WRITE_TOKEN, prefix = 'kindred-cache' } = {}) {
  let sdk;
  const load = async () => (sdk ??= await import('@vercel/blob'));
  return {
    kind: 'blob',
    async get(key) {
      const { get } = await load();
      const r = await get(`${prefix}/${key}.json`, { access: 'private', token });
      if (!r || r.statusCode !== 200) return undefined;
      return JSON.parse(await new Response(r.stream).text());
    },
    async set(key, value) {
      const { put } = await load();
      await put(`${prefix}/${key}.json`, JSON.stringify(value), {
        access: 'private', token, contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true,
      });
    },
  };
}

/** Two tiers: a per-instance memory layer in front of an optional persistent store. */
export function createTieredCache({ persistent = null, memory = createMemoryStore(), ttlMs = 14 * DAY, now = () => Date.now(), log = () => {} } = {}) {
  const fresh = (rec) => rec && typeof rec === 'object' && 't' in rec && now() - rec.t < ttlMs;
  return {
    persistentKind: persistent?.kind ?? null,
    async get(key) {
      const m = await memory.get(key);
      if (fresh(m)) return { value: m.v, from: 'memory' };
      if (!persistent) return undefined;
      try {
        const p = await persistent.get(key);
        if (fresh(p)) { await memory.set(key, p); return { value: p.v, from: persistent.kind }; }
      } catch (err) { log(`cache read failed: ${err?.name || 'error'}`); }
      return undefined;
    },
    async set(key, value) {
      const rec = { t: now(), v: value };
      await memory.set(key, rec);
      if (!persistent) return;
      try { await persistent.set(key, rec); } catch (err) { log(`cache write failed: ${err?.name || 'error'}`); }
    },
  };
}

/** Pick the persistent store from the environment. */
export function persistentStoreFromEnv(env = process.env) {
  if (env.BLOB_READ_WRITE_TOKEN) return createBlobStore({ token: env.BLOB_READ_WRITE_TOKEN });
  if (env.KINDRED_CACHE_DIR) return createFileStore(env.KINDRED_CACHE_DIR);
  return null;
}
