# football-scout-api

A football scouting dashboard: upcoming fixtures across 15 competitions (top-5 European
leagues plus Primeira Liga, Eredivisie, Belgian Pro League, EFL Championship, Brasileirão,
Champions League, EFL Cup, FA Cup, World Cup and Friendlies), match-winner odds from
API-Football, and a short AI scouting note per match from DeepSeek.

Data gathering is fully decoupled from page views:

```
GitHub Actions (09:00, 13:00, 17:00, 21:00 UTC, or manual)
  └─ scripts/sync.js                      (free-plan friendly: ~9-20 requests/run)
       ├─ API-Football  → one /fixtures?date= call per day (7-day window)
       │                  + /odds?date= pages for the nearest 2 days
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
shared/leagues.js              Single source of truth for the 15 tracked leagues
scripts/sync.js                Rolling 7-day sync (fixtures + odds + AI) → Cloudflare KV
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
  "window": { "from": "2026-10-20", "to": "2026-10-26" },
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
  "odds_pages": { "fetched": 12, "available": 30 },
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

The API-Football **free plan** rejects `from`/`to` range queries for the current season
(`{"plan":"Free plans do not have access to this season"}`), so the sync uses date-scoped calls:

- Fixtures: one `/fixtures?date=<day>&timezone=UTC` request per day across the 7-day window
  (7 requests), filtered to the 15 tracked leagues and deduped by `fixture.id`.
- Odds: `/odds?date=<day>&timezone=UTC` for the nearest `ODDS_WINDOW_DAYS` (default 2) days,
  matched back to fixtures by `fixture.id`. Each day is paginated by the API (10 fixtures per
  page, ~15 pages/day across all competitions), so `ODDS_MAX_PAGES` (default 6) caps pages per
  day and the log warns when coverage is truncated.
- **Request budget**: `MAX_REQUESTS_PER_RUN` (default 20) is enforced end to end — fixtures
  first, then odds split across the odds days. With four runs/day that is ≤80 of the 100
  requests/day allowance.
- A daily-limit response stops further calls for that run, logs a warning, and still uploads
  what was gathered (`quota_exhausted: true`). Bad credentials still fail the workflow.
- Grace period: matches that kicked off more than 4 hours ago are dropped before upload.
- DeepSeek: only for matches that have odds, 3 at a time (`AI_CONCURRENCY`).
- Metrics logged each run: total active matches, active days, average per active day, peak day,
  and a loud warning for any day above 75 matches:
  `⚠️ PEAK DAY WARNING: {date} has {count} matches. Manual review recommended.`
- Every run writes `snapshot-latest` (read by the site) plus `snapshot-<YYYY-MM-DD>` as an archive.
- `workflow_dispatch` accepts an optional `date` input (`SYNC_DATE`), useful for backfills.
- Cron is UTC: `0 9,13,17,21 * * *` → 09:00, 13:00, 17:00 and 21:00.

If you upgrade to a paid plan, you can switch back to `from`/`to` + `season` range queries
(1 fixtures request instead of 7) and raise `ODDS_MAX_PAGES`.

## Routes

- `/` — league-filtered fixture grid
- `/match/:id` — AI detail page (client-side route, served via `public/_redirects`)
