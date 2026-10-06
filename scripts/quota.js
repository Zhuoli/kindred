// Prints the remaining Qloo quota from response headers (costs one request).
// Usage: set -a; . ./.env; set +a; node scripts/quota.js   (key read from env, never printed)
const base = (process.env.QLOO_API_URL || 'https://hackathon.api.qloo.com').replace(/\/+$/, '');
const res = await fetch(`${base}/search?query=radiohead&take=1`, { headers: { 'X-Api-Key': process.env.QLOO_API_KEY ?? '' } });
const out = { status: res.status };
for (const [k, v] of res.headers) if (/ratelimit|quota|remaining|limit/i.test(k)) out[k] = v;
console.log(JSON.stringify(out, null, 2));
