import { createQlooClient, QlooError, quota } from './qloo.js';
import { runAgent, runCheck, validateRequest, validateCheck } from './agent.js';
import { runTogether, validateTogether } from './together.js';
import { cachedRun, quotaExhausted, sharedPlanCache, quotaReserve } from './plan-cache.js';
import { EXAMPLES } from './examples.js';

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 15;
const hits = new Map();

export function rateLimited(ip, now = Date.now()) {
  const rec = hits.get(ip);
  if (!rec || now - rec.start > WINDOW_MS) { hits.set(ip, { start: now, n: 1 }); return false; }
  rec.n += 1;
  if (hits.size > 5000) hits.clear();
  return rec.n > MAX_PER_WINDOW;
}
export function resetRateLimit() { hits.clear(); }

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 16_384) throw new Error('too large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

const validateAny = (input) => (input?.mode === 'us' ? validateTogether(input) : validateRequest(input));
const exampleKeys = new Set(EXAMPLES.map((e) => JSON.stringify(validateAny(e.input).value)));
export const isExample = (value) => exampleKeys.has(JSON.stringify(value));

/** Clients that send Accept: application/x-ndjson get live agent steps, one JSON object per line. */
export const wantsStream = (req) => /application\/x-ndjson/.test(String(req.headers?.accept ?? ''));

function startStream(res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  return (obj) => { try { res.write(`${JSON.stringify(obj)}\n`); } catch { /* client went away */ } };
}

function makeHandler({ kind: baseKind, validate, run, clientFactory, cache, guard, route = null }) {
  return async function handler(req, res) {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, { ok: false, error: 'Use POST' }); }
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local').split(',')[0].trim();
    if (rateLimited(ip)) return send(res, 429, { ok: false, error: 'Too many requests in a minute. Take a breath and try again.' });
    let body;
    try { body = await readJson(req); } catch { return send(res, 400, { ok: false, error: 'Invalid JSON body' }); }
    const r = route ? route(body) : { kind: baseKind, validate, run };
    const { kind } = r;
    const v = r.validate(body);
    if (!v.ok) return send(res, 400, { ok: false, error: v.errors.join(' ') });
    const stream = wantsStream(req) ? startStream(res) : null;
    const reply = (status, payload) => {
      if (!stream) return send(res, status, payload);
      stream({ type: 'result', status, result: payload });
      return res.end();
    };
    try {
      const example = kind !== 'check' && isExample(v.value);
      const result = await cachedRun({
        kind, value: v.value, cache: cache ?? sharedPlanCache(),
        guard: example ? () => false : (guard ?? quotaExhausted),
        run: () => r.run(v.value, { qloo: clientFactory(), onEvent: stream }),
      });
      if (example) result.example = true;
      const status = result.status ?? (result.ok ? 200 : 422);
      delete result.status;
      return reply(status, result);
    } catch (err) {
      const status = err instanceof QlooError && err.status === 401 ? 502 : 500;
      // Never echo internals or credentials to the client.
      console.error(`[${kind}] failed:`, err instanceof QlooError ? err.message : err?.name);
      return reply(status, { ok: false, error: 'The taste engine is unavailable right now. Please try again shortly.' });
    }
  };
}

/**
 * POST /api/plan  { friend, loves[], interests[], city, occasion, budget, vibe, surprise }
 * "Us" mode: add { mode: 'us', you, yourLoves[], yourInterests[] } to plan for both of you.
 * Send Accept: application/x-ndjson to receive live agent steps before the result.
 */
export function makePlanHandler({ clientFactory = () => createQlooClient(), cache, guard } = {}) {
  const route = (body) => (body?.mode === 'us'
    ? { kind: 'together', validate: validateTogether, run: runTogether }
    : { kind: 'plan', validate: validateRequest, run: runAgent });
  return makeHandler({ kind: 'plan', clientFactory, cache, guard, route });
}

/** POST /api/check  { loves[], interests[], city, candidate } -> "would they like it?" */
export function makeCheckHandler({ clientFactory = () => createQlooClient(), cache, guard } = {}) {
  return makeHandler({ kind: 'check', validate: validateCheck, run: runCheck, clientFactory, cache, guard });
}

/** GET /api/examples -> example friends (inputs only). */
export function examplesHandler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, examples: EXAMPLES.map(({ id, title, blurb, input }) => ({ id, title, blurb, mode: input.mode === 'us' ? 'us' : 'gift', input })) }));
}

/** GET /api/health -> config + quota snapshot (no secrets). */
export function healthHandler(req, res) {
  send(res, 200, {
    ok: true,
    version: '0.3.0',
    qlooConfigured: Boolean(process.env.QLOO_API_KEY),
    cache: sharedPlanCache().persistentKind ?? 'memory',
    quota: { monthRemaining: quota.remaining, monthLimit: quota.limit, readAt: quota.at ? new Date(quota.at).toISOString() : null, reserve: quotaReserve(), pacing: quotaExhausted() },
  });
}
