// Server-side Qloo client. The API key is read from process.env at call time
// and is only ever placed in the X-Api-Key request header. It is never logged,
// returned to callers, or included in error messages.

import { join } from 'node:path';
import { cacheKey, createFileStore, createMemoryStore, createTieredCache } from './cache.js';

const DEFAULT_BASE = 'https://hackathon.api.qloo.com';
const TIMEOUT_MS = 12000;

export class QlooError extends Error {
  constructor(message, { status, path } = {}) {
    super(message);
    this.name = 'QlooError';
    this.status = status;
    this.path = path;
  }
}

// Per-request cache: memory per instance, plus a gitignored folder in local dev
// (KINDRED_CACHE_DIR). Production persists whole plans instead (see lib/plan-cache.js),
// which keeps Blob writes low. Private server-side caching is allowed by Qloo.
let urlCache = createTieredCache({
  persistent: process.env.KINDRED_CACHE_DIR ? createFileStore(join(process.env.KINDRED_CACHE_DIR, 'qloo')) : null,
  memory: createMemoryStore({ max: 400 }),
  ttlMs: 7 * 24 * 60 * 60 * 1000,
});
export function clearCache() { urlCache = createTieredCache({ memory: createMemoryStore({ max: 400 }) }); }

// Latest monthly quota reading from Qloo's response headers (per instance).
export const quota = { limit: null, remaining: null, at: null, networkCalls: 0, cacheHits: 0 };
export function noteQuota(headers, now = Date.now()) {
  const get = (k) => (typeof headers?.get === 'function' ? headers.get(k) : headers?.[k]);
  const rem = Number.parseInt(get('x-month-ratelimit-remaining'), 10);
  const lim = Number.parseInt(get('x-month-ratelimit-limit'), 10);
  if (Number.isFinite(rem)) { quota.remaining = rem; quota.at = now; }
  if (Number.isFinite(lim)) quota.limit = lim;
}

// Hackathon keys allow 5 requests/second (x-second-ratelimit-limit) and 10k/month.
// Space calls out per instance and retry 429s with backoff.
export function createThrottle({ perSecond = 4, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  const gap = 1000 / perSecond;
  let next = 0;
  return async function slot() {
    const t = now();
    const at = Math.max(t, next);
    next = at + gap;
    if (at > t) await sleep(at - t);
  };
}
const sharedThrottle = createThrottle();

export function buildQuery(params = {}) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  return usp.toString();
}

export function createQlooClient({
  apiKey = process.env.QLOO_API_KEY,
  baseUrl = process.env.QLOO_API_URL || DEFAULT_BASE,
  fetchImpl = globalThis.fetch,
  useCache = true,
  throttle = sharedThrottle,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxRetries = 3,
} = {}) {
  if (!apiKey) throw new QlooError('Qloo API key is not configured on the server', { status: 500 });
  const base = baseUrl.replace(/\/+$/, '');

  async function get(path, params) {
    const qs = buildQuery(params);
    const url = `${base}${path}${qs ? `?${qs}` : ''}`;
    const key = cacheKey('qloo', url);
    if (useCache) {
      const hit = await urlCache.get(key);
      if (hit) { quota.cacheHits += 1; return hit.value; }
    }
    let res;
    for (let attempt = 0; ; attempt++) {
      await throttle();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        res = await fetchImpl(url, { headers: { 'X-Api-Key': apiKey, Accept: 'application/json' }, signal: ctrl.signal });
      } catch (err) {
        throw new QlooError(err?.name === 'AbortError' ? 'Qloo request timed out' : 'Qloo request failed', { path });
      } finally {
        clearTimeout(timer);
      }
      quota.networkCalls += 1;
      noteQuota(res.headers);
      if (res.status !== 429 || attempt >= maxRetries) break;
      await sleep(400 * 2 ** attempt + Math.floor(Math.random() * 150));
    }
    let body;
    try { body = await res.json(); } catch { body = undefined; }
    if (!res.ok) {
      const detail = body?.errors?.[0]?.message || body?.error?.message || body?.message || '';
      throw new QlooError(`Qloo ${path} returned ${res.status}${detail ? `: ${String(detail).slice(0, 200)}` : ''}`, { status: res.status, path });
    }
    if (useCache) await urlCache.set(key, body);
    return body;
  }

  return {
    /** Entity search by name. Returns an array of entities. */
    async search(query, { types, take = 5 } = {}) {
      const body = await get('/search', { query, types, take });
      return Array.isArray(body?.results) ? body.results : [];
    },
    /** Tag search, e.g. to turn "ramen" into urn:tag:... ids. */
    async tags(query, { parentTypes, take = 5 } = {}) {
      const body = await get('/v2/tags', { 'filter.query': query, 'filter.parents.types': parentTypes, take });
      return body?.results?.tags ?? [];
    },
    /** Insights API (GET, params in query string per hackathon guide). */
    async insights(params) {
      if (!params?.['filter.type']) throw new QlooError('filter.type is required', { status: 400, path: '/v2/insights' });
      const body = await get('/v2/insights', params);
      const r = body?.results ?? {};
      return { entities: r.entities ?? [], tags: r.tags ?? [], query: body?.query ?? {} };
    },
  };
}
