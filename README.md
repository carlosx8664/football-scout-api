# football-scout-api

A football scouting dashboard: today's fixtures from 10 major leagues, match-winner odds from
API-Football, and a short AI scouting note per match from DeepSeek.

Data gathering is fully decoupled from page views:

```
GitHub Actions (09:00 UTC, or manual)
  └─ scripts/sync.js
       ├─ API-Football  → fixtures (1 request) + odds (1 request per fixture, 6s apart)
       ├─ DeepSeek      → 2-sentence analysis per fixture
       └─ Cloudflare KV → snapshot-<YYYY-MM-DD>

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
shared/leagues.js              Single source of truth for the tracked leagues
scripts/sync.js                Daily data sync (fixtures + odds + AI) → Cloudflare KV
.github/workflows/daily-sync.yml   Cron at 09:00 UTC + manual workflow_dispatch
functions/api/snapshot.js      GET /api/snapshot - reads the KV snapshot, never the APIs
src/App.tsx                    Route switch, snapshot loading, league filter
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
npx wrangler kv key put --binding FOOTBALL_DATA "snapshot-$(date -u +%F)" --path snapshot.json --local
```

Without a snapshot the app shows *"Data for today is not ready yet. The daily sync runs at 9 AM."*
(after the first sync it shows the most recent slate with a "showing the most recent slate"
banner until today's data lands).

Other scripts: `npm run build`, `npm run lint`, `npm run deploy`.

## API

`GET /api/snapshot` returns the stored payload verbatim:

```jsonc
{
  "status": "success",
  "date": "2026-10-20",
  "generated_at": "2026-10-20T09:00:12.000Z",
  "quota_remaining": "91",
  "quota_exhausted": false,
  "match_count": 12,
  "analysed_count": 12,
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

If `snapshot-<today>` is missing, the Function falls back to `snapshot-latest` (the previous
run's payload) and flags it, so visitors see the last known slate instead of an empty page:

```json
{
  "status": "success",
  "date": "2026-10-19",
  "stale": true,
  "message": "Showing the most recent slate (2026-10-19). Today's sync runs at 9 AM.",
  "match_count": 12,
  "matches": ["..."]
}
```

If neither key exists (first ever deploy), it returns HTTP 200 with a friendly placeholder:

```json
{
  "status": "pending",
  "date": "2026-10-20",
  "message": "Data for today is not ready yet. The daily sync runs at 9 AM.",
  "match_count": 0,
  "matches": []
}
```

## Sync behaviour and quota safety

- Every run writes both `snapshot-<YYYY-MM-DD>` and `snapshot-latest`, so the fallback above is
  always one day behind at most.
- 1 fixtures request per run, then one odds request per fixture spaced `ODDS_DELAY_MS` apart
  (default `6000`, sized for the free plan's 10 req/min and 100 req/day).
- `MAX_ODDS_REQUESTS` (default `95`) caps a run so a rerun still fits in the daily allowance.
- A daily-limit response stops the odds loop immediately and still uploads what was gathered
  (the workflow logs a warning).
- Failures are per fixture: a missing fixture's odds or AI text is recorded in `ai_analysis`
  instead of failing the whole run.
- `workflow_dispatch` accepts an optional `date` input (`SYNC_DATE`), useful for backfills.
- Cron is UTC; `0 9 * * *` is 09:00 UTC.

## Routes

- `/` — league-filtered fixture grid
- `/match/:id` — AI detail page (client-side route, served via `public/_redirects`)
