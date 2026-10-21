# football-scout-api

A football scouting dashboard: upcoming fixtures across 16 competitions (top-5 European
leagues plus Primeira Liga, Eredivisie, Belgian Pro League, EFL Championship, Brasileirão,
Champions League, Conference League, EFL Cup, FA Cup, World Cup and Friendlies) for **today and tomorrow**,
match-winner odds from API-Football, and a short AI scouting note per match from DeepSeek.

Data gathering is fully decoupled from page views:

```
GitHub Actions (09:07, 18:07 UTC, or manual)
  └─ scripts/sync.js                      (free-plan friendly: max 42 requests/run)
       ├─ API-Football  → /fixtures?date=<day> with pagination, then filter to 16 leagues
       │                  + /odds?fixture=<id> for up to 10 target matches (6.5s apart)
       ├─ DeepSeek      → 2-sentence analysis for matches with odds (3 at a time)
       └─ Cloudflare KV → snapshot-latest (+ snapshot-<YYYY-MM-DD> archive)

Visitor → Pages Function → KV read (0 API-Football requests)
```

The Pages Function never calls API-Football or DeepSeek, so traffic can never drain the quota.

## Stack

| Layer | Tech |
| --- | --- |
| UI | React 19 + TypeScript, Vite 8 |
| Hosting | Cloudflare Pages (Functions + KV) |
| Sync job | GitHub Actions + a Node 20 script using `axios` |
| Fixtures/odds | [API-Football v3](https://www.api-football.com/) |
| AI | [DeepSeek](https://api-docs.deepseek.com/), optionally via Cloudflare AI Gateway |
| Lint | Oxlint |

## Project layout

```
shared/leagues.js              Single source of truth for the 16 tracked leagues
scripts/sync.js                Today + tomorrow sync (fixtures + odds + AI) → Cloudflare KV
.github/workflows/daily-sync.yml   Cron at 09/13/17/21 UTC + manual workflow_dispatch
functions/api/snapshot.js      GET /api/snapshot - reads snapshot-latest from KV, never the APIs
src/App.tsx                    Route switch, snapshot loading, upcoming + league filters
src/components/                Header, Sidebar, MainFeed, RightSidebar, MatchDetail (+ CSS)
src/lib/                       Fetch helper and formatting utils
src/types.ts                   Snapshot payload types
public/_redirects              Serves the SPA for /match/:id deep links
```

## One-time setup

### 1. Create the KV namespace

```bash
npx wrangler kv namespace create FOOTBALL_DATA
```

Copy the returned `id` into [`wrangler.jsonc`](./wrangler.jsonc) (replacing the placeholder
value `dbf948e365cd4d95ba73cebf4bb35a0a`, which Wrangler generated for local development) and
use the same value as the `CF_KV_NAMESPACE_ID` GitHub secret. For preview deployments, also add
a `preview_id` with the id of `wrangler kv namespace create FOOTBALL_DATA --preview`.

> Alternatively, bind it in the Cloudflare dashboard: **Pages → your project → Settings →
> Functions → KV namespace bindings**, with the variable name `FOOTBALL_DATA`.

### 2. Add GitHub repository secrets

| Secret | Where to get it |
| --- | --- |
| `API_FOOTBALL_KEY` | API-Football dashboard → API key |
| `DEEPSEEK_API_KEY` | DeepSeek platform → API keys |
| `CF_ACCOUNT_ID` | Cloudflare dashboard → any zone/Workers overview (right-hand account id) |
| `CF_KV_NAMESPACE_ID` | Output of the `kv namespace create` command above |
| `CF_API_TOKEN` | Cloudflare → My Profile → API Tokens → create a token with **Workers KV Storage: Edit** (scoped to your account) |

Optional (only for AI Gateway routing): `CF_GATEWAY_ID`, `CF_AIG_TOKEN`.

Add them under **Settings → Secrets and variables → Actions → New repository secret**.

### 3. Run the sync once

Actions → **Daily football sync** → *Run workflow*. Or locally:

```bash
cp .dev.vars.example .dev.vars    # fill in the values
node scripts/sync.js --dry-run --out snapshot.json   # inspect the payload, no upload
node scripts/sync.js                                 # upload to KV
```

## Local development

```bash
npm install
npm run preview   # builds + serves the Pages app (Functions + local KV) on :8788
npm run dev       # Vite on :5173, proxies /api -> :8788
```

To see real data locally, run the sync (above) or seed a snapshot into the local KV:

```bash
npx wrangler kv key put --binding FOOTBALL_DATA "snapshot-latest" --path snapshot.json --local
```

Without a snapshot the app shows *"Today's matches are not available yet. The next sync will
refresh them shortly."*

Other scripts: `npm run build`, `npm run lint`, `npm run deploy`.

## API

`GET /api/snapshot` reads `snapshot-latest` and returns the stored payload verbatim:

```jsonc
{
  "status": "success",
  "date": "2026-10-20",
  "window": { "from": "2026-10-20", "to": "2026-10-21" },
  "generated_at": "2026-10-20T13:00:12.000Z",
  "quota_remaining": "91",
  "quota_exhausted": false,
  "requests_used": 9,
  "match_count": 128,
  "odds_count": 96,
  "analysed_count": 96,
  "metrics": {
    "total": 128,
    "activeDays": 6,
    "averagePerActiveDay": 21.3,
    "peakDay": "2026-10-25",
    "peakCount": 44,
    "days": [{ "day": "2026-10-20", "count": 18 }]
  },
  "odds_requests": 12,
  "ai_concurrency": { "limit": 3, "peak": 3 },
  "matches": [
    {
      "fixture": { "id": 1234, "date": "2026-10-20T19:00:00+00:00" },
      "league": { "id": 39, "name": "Premier League", "logo": "..." },
      "teams": { "home": { "name": "...", "logo": "..." }, "away": { "name": "...", "logo": "..." } },
      "goals": { "home": null, "away": null },
      "odds": [{ "value": "Home", "odd": "1.80" }, { "value": "Draw", "odd": "3.50" }, { "value": "Away", "odd": "4.20" }],
      "ai_analysis": "..."
    }
  ]
}
```

If `snapshot-latest` does not exist yet (first ever deploy), it returns HTTP 200 with a
friendly placeholder:

```json
{
  "status": "pending",
  "date": "2026-10-20",
  "message": "Today's matches are not available yet. The next sync will refresh them shortly.",
  "match_count": 0,
  "matches": []
}
```

## Sync behaviour and quota safety

The API-Football **free plan** rejects `from`/`to` range queries and season-specific fixture
queries for the current season, so the sync uses global date-scoped fixture calls:

- Fixtures: `/fixtures?date=<day>&timezone=UTC` for today and tomorrow. Each date's response is
  paginated using `paging.total`; fetched pages are combined and deduped by `fixture.id` before
  filtering to the 16 tracked leagues. Pagination is capped to leave room for odds requests.
- Odds: `/odds?fixture=<id>` is requested for target-league fixtures in kickoff order. All
  API-Football calls are spaced 6.5 seconds apart to stay within the free-tier rate limit.
- **Request budget**: `MAX_REQUESTS_PER_RUN` (default 42 = up to 32 fixture pages + up to 10
  odds requests) caps calls per run. The twice-daily schedule uses at most 84 requests/day,
  inside the free plan's 100/day allowance. If fixture pagination reaches its cap, the log warns
  how many pages remain.
- A daily-limit response stops further calls for that run, logs a warning, and still uploads
  what was gathered (`quota_exhausted: true`). Bad credentials still fail the workflow.
- Grace period: today's matches that kicked off more than 4 hours ago are dropped before upload;
  tomorrow's and other future-day matches bypass the grace period.
- DeepSeek: only for matches that have odds, 3 at a time (`AI_CONCURRENCY`).
- Metrics logged each run: total active matches, active days, average per active day, peak day,
  and a loud warning for any day above 75 matches:
  `⚠️ PEAK DAY WARNING: {date} has {count} matches. Manual review recommended.`
- Every run writes `snapshot-latest` (read by the site) plus `snapshot-<YYYY-MM-DD>` as an archive.
- `workflow_dispatch` accepts an optional `date` input (`SYNC_DATE`), useful for backfills.
- Cron is UTC: `7 9,18 * * *` → 09:07 and 18:07.
- The site polls `/api/snapshot` every 15 minutes and refetches only when a match kicks off within
  the next hour, so late odds/analysis land without any extra API-Football requests.

The `odds_requests` field reports how many per-fixture odds requests were made during the run.

## Routes

- `/` — fixture grid with **Today's Matches** / **Tomorrow's Matches** tabs and a league filter.
  Today hides matches that have already kicked off; tomorrow shows the full slate.
- `/match/:id` — AI detail page (client-side route, served via `public/_redirects`)
