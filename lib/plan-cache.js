// Plan-level cache and global quota guard.
//
// Whole plans / checks are cached by their normalised input in a private store
// (a private Vercel Blob store in production), so repeat and example requests
// cost zero Qloo calls and one Blob read. The guard reads Qloo's own monthly
// counter (x-month-ratelimit-remaining), which is global across all instances,
// and stops spending fresh calls when the remaining quota drops below a reserve.

import { cacheKey, createTieredCache, persistentStoreFromEnv } from './cache.js';
import { quota } from './qloo.js';
import { ALGO_VERSION } from './agent.js';
import { TOGETHER_VERSION } from './together.js';

const DAY = 24 * 60 * 60 * 1000;

let shared;
export function sharedPlanCache() {
  shared ??= createTieredCache({ persistent: persistentStoreFromEnv(), ttlMs: 21 * DAY, log: (m) => console.warn(`[cache] ${m}`) });
  return shared;
}

export function planKey(kind, value) {
  return cacheKey(kind, { v: kind === 'together' ? TOGETHER_VERSION : ALGO_VERSION, ...value });
}

export function quotaReserve(env = process.env) {
  const n = Number.parseInt(env.KINDRED_QUOTA_RESERVE ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 1000;
}

/** true when fresh Qloo calls should stop (cached and example plans keep working). */
export function quotaExhausted({ q = quota, reserve = quotaReserve() } = {}) {
  return q.remaining != null && q.remaining < reserve;
}

/** A plan is cacheable only if nothing failed along the way. */
export function cacheable(result) {
  return Boolean(result?.ok) && !(result.trace ?? []).some((t) => t.error);
}

/**
 * Serve from cache or compute. Returns the result plus a `cache` field the UI shows.
 */
export async function cachedRun({ kind, value, run, cache = sharedPlanCache(), guard = quotaExhausted }) {
  const key = planKey(kind, value);
  const hit = await cache.get(key);
  if (hit) return { ...hit.value, cache: { hit: true, from: hit.from, savedCalls: hit.value.trace?.length ?? 0 } };
  if (guard()) {
    return { ok: false, status: 503, error: 'Kindred is pacing its Qloo quota right now. The example friends still work instantly; please try your own plan again later.' };
  }
  const result = await run();
  if (cacheable(result)) await cache.set(key, result);
  return { ...result, cache: { hit: false } };
}
