// Live smoke test against the real Qloo hackathon API.
// Usage: QLOO_API_KEY=... node scripts/smoke.js ['{"loves":["..."],"city":"..."}']   (key read from env, never printed)
import { createQlooClient, quota } from '../lib/qloo.js';
import { runAgent, runCheck, validateRequest, validateCheck } from '../lib/agent.js';

const input = process.argv[2] ? JSON.parse(process.argv[2])
  : { friend: 'Maya', loves: ['Phoebe Bridgers', 'Lady Bird', 'Tartine Bakery'], interests: ['natural wine'], city: 'San Francisco', vibe: 'dinner', budget: 3 };
const qloo = createQlooClient();
const names = (xs) => (xs ?? []).map((x) => `${x.name}${x.kind ? ` [${x.kind}${x.priceLevel ? ' ' + '$'.repeat(x.priceLevel) : ''}]` : ''}${x.because?.length ? ` (because: ${x.because.map((b) => b.name).join(', ')})` : ''}${x.into?.length ? ` (into: ${x.into.join(', ')})` : ''}`);
let plan;
if (input.candidate) {
  plan = await runCheck(validateCheck(input).value, { qloo });
  console.log(JSON.stringify({ ok: plan.ok, error: plan.error, candidate: plan.candidate?.name, type: plan.candidate?.type, affinity: plan.affinity, verdict: plan.verdict, because: plan.because, alternatives: names(plan.alternatives), warnings: plan.warnings, calls: plan.trace.length }, null, 2));
} else {
  plan = await runAgent(validateRequest(input).value, { qloo });
  console.log(JSON.stringify({
    ok: plan.ok, ms: plan.ms, error: plan.error,
    loved: plan.loved?.map((l) => `${l.name} [${l.type}]`), interests: plan.interests,
    profile: plan.profile?.map((t) => t.name),
    brands: names(plan.gifts?.brands), books: names(plan.gifts?.books), artists: names(plan.gifts?.artists),
    main: names(plan.outing?.main?.picks), after: names(plan.outing?.after?.picks),
    warnings: plan.warnings, calls: plan.trace?.length,
    vetted: plan.trace?.filter((t) => t.dropped || t.note).map((t) => `${t.step}: kept ${t.kept}${t.note ? ' (' + t.note + ')' : ''}; dropped ${(t.dropped ?? []).join(' | ')}`),
    errors: plan.trace?.filter((t) => t.error).map((t) => t.error),
  }, null, 2));
}
console.error(`[quota] network calls: ${quota.networkCalls}, cache hits: ${quota.cacheHits}, month remaining: ${quota.remaining ?? 'unknown (all cached)'}`);
process.exit(plan.ok ? 0 : 1);
