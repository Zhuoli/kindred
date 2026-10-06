# Kindred

**Gifts and outings that fit one specific friend.** Tell Kindred a few things your friend loves (an artist, a film, a show, a book, a brand, a favourite bakery), plus any interests in your own words ("natural wine", "vinyl", "hiking"). It plans a gift and an outing for them, and every pick comes with the reason it fits: *"because they love Phoebe Bridgers and Lady Bird, and they're into natural wine."* Already have a gift in mind? **Would they like it?** scores it against their taste.

Live demo: https://kindred-qloo.vercel.app (no login; try one of the pre-built example friends)

Built for the [Qloo Agentic Hackathon](https://qloo.devpost.com/).

## What makes it Qloo-powered

A generic LLM guesses at gifts from stereotypes. Kindred works from what this particular friend actually loves, across domains, using Qloo's taste graph for every pick. There is no LLM in the loop: the agent is a deterministic planner that calls Qloo tools, checks what comes back, and corrects itself.

1. **Resolve.** Free-text loves become Qloo entities through `GET /search` (artists, films, TV, books, podcasts, games, people, brands, places). Anything that isn't a specific title or name falls back to an interest.
2. **Interests.** Phrases like "natural wine" become Qloo tags through `GET /v2/tags`, once for places and once for brands and media. They're sent as `signal.interests.tags` so they steer both the gifts and the outing.
3. **Taste fingerprint.** `GET /v2/insights?filter.type=urn:tag` turns the friend's media loves into the genres that define their taste.
4. **Cross-domain gifts.** `GET /v2/insights` for brands, books and artists, with `feature.explainability` on and `filter.exclude.entities` so nothing they already love comes back.
   - **Brands** are limited to giftable categories (`filter.tags` with fashion, beauty and home accessories) and capped with `filter.popularity.max` to skip mass-market names. Every result is then checked: consumables, apps, government and sports brands, and prescription-eyewear retailers are dropped.
   - **Books and artists** are driven by media loves only, so a favourite bakery doesn't skew the reading list.
   - Picks are re-ranked for variety: Qloo's affinity order, minus a penalty for sharing most tags with a pick already chosen.
5. **Outing in their city.** Place insights use `filter.location.query`, venue `filter.tags`, `filter.exclude.tags` (cafés out of Dinner, for example) and `filter.price_level.min/max`. Kindred then checks every venue:
   - **Right type for the leg**, using Qloo's primary genre: no cocktail bar under Dinner, no bowling alley under Drinks.
   - **Open in the evening** for evening legs, using Qloo's hours, unless the venue lists a Dinner dining option.
   - **Not a chain**: matched against a list of known chains and Qloo's chain and fast-food tags. Places with three or more branches in the results are moved to the end.
6. **Self-correction.** When too few results survive the checks (say, no $$$ restaurants pass), the agent loosens its own filters, tries again, and records that in the trace.
7. **Would they like it?** The candidate is resolved, then scored with `filter.results.entities=<id>`, which returns its affinity to the friend's taste. The affinity is mapped to a plain verdict, with the loves that drove it and stronger alternatives from the same category.
8. **Explain.** Qloo's explainability scores are mapped back to the friend's loves, and matching interest tags are shown too.

The UI shows the full agent trace: each Qloo call with its parameters, result count and latency, plus which results were vetted out and why.

## Protecting the quota

Hackathon keys allow 10,000 Qloo calls a month. Kindred protects them in three ways:

- **Private persistent cache.** Whole plans and checks are cached by their normalised input in a *private* Vercel Blob store (production) or a gitignored local folder (development), with a per-instance memory layer in front. A repeat request costs zero Qloo calls. Qloo allows private server-side caching; **no Qloo response data is ever committed to this repo**, and all test fixtures are synthetic.
- **Pre-built example friends.** The repo stores only the example *inputs* (`lib/examples.js`). Their plans are computed once and served from the private cache, so judges get instant results at no quota cost.
- **Quota guard.** Kindred reads Qloo's own monthly counter (`x-month-ratelimit-remaining`) from every response. Below a reserve (`KINDRED_QUOTA_RESERVE`, default 1000) it stops making fresh calls. Cached plans and examples keep working.

On top of that: per-IP rate limiting, a 4-requests-per-second throttle (the key allows 5), and retry with backoff on 429.

## API

| Route | What it does |
|---|---|
| `POST /api/plan` | `{ friend, occasion, loves[], interests[], city, vibe: dinner\|daytime\|night, budget: 1-4, surprise }` → gifts, outing, trace |
| `POST /api/check` | `{ loves[], interests[], city, candidate }` → affinity, verdict, reasons, alternatives |
| `GET /api/examples` | Example friends (inputs only) |
| `GET /api/health` | Configuration and quota snapshot (no secrets) |

## Architecture

```
public/              static UI (vanilla JS; never sees the API key)
api/*.js             Vercel functions -> lib/handler.js (validation, rate limit, cache, quota guard, error hygiene)
lib/agent.js         planner: resolve -> interests -> fingerprint -> parallel vetted tools -> relax -> explain; runCheck
lib/venues.js        outing legs, venue-type validation, evening hours, chain detection
lib/gifts.js         giftable-brand rules, mainstream cap, diversity re-ranking
lib/interests.js     free-text interests -> Qloo tags
lib/plan-cache.js    plan-level cache + quota guard
lib/cache.js         memory / file / private Blob stores
lib/qloo.js          server-only Qloo client: X-Api-Key header, GET, throttle, 429 retry, per-request cache, quota reading
lib/examples.js      example friends (inputs only)
test/                node:test unit tests with synthetic fixtures
```

## Run locally

Requires Node 22.

```bash
npm install
cp .env.example .env    # add your Qloo hackathon key; never commit it
set -a; . ./.env; set +a
npm test                # unit tests (no network)
npm run smoke           # one live end-to-end plan against the Qloo API
npm run dev             # http://localhost:3000
```

Set `KINDRED_CACHE_DIR=.cache` to cache Qloo responses in a gitignored local folder while developing.

To deploy on Vercel:

1. Set `QLOO_API_KEY` (and optionally `QLOO_API_URL`) as server-side environment variables.
2. Optionally, create a private Blob store with `vercel blob create-store kindred-cache --access private`. That sets `BLOB_READ_WRITE_TOKEN` and turns on the persistent cache.

## License

MIT. See [LICENSE](LICENSE).
