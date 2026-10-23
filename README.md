# football-scout-api

A football scouting dashboard: upcoming fixtures across 16 competitions (top-5 European
leagues plus Primeira Liga, Eredivisie, Belgian Pro League, EFL Championship, Brasileirão,
Champions League, Conference League, EFL Cup, FA Cup, World Cup and Friendlies) for **today and tomorrow**,
match-winner odds from API-Football, and a short AI scouting note per match from DeepSeek.

Data gathering is fully decoupled from page views:

```
GitHub Actions (00:01, 12:01 UTC, or manual)
  └─ scripts/sync.js                      (fixture pages capped; odds fetched for all eligible matches)
       ├─ API-Football  → /fixtures?date=<day> with pagination, then filter to 16 leagues
       │                  + /odds?fixture=<id> for all eligible matches (6.5s apart)
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
.github/workflows/odds-refresh.yml  Every 15 min: scrape odds, build feeds, publish to KV
functions/api/matches.js       GET /api/matches - KV feed-matches (odds refresh output)
functions/api/arbs.js          GET /api/arbs - KV feed-arbs (arbitrage output)
functions/api/analysis.js      GET /api/analysis - on-demand DeepSeek note with live search
functions/api/standings.js     GET /api/standings - league table via football-data.org
functions/api/snapshot.js      Legacy GET /api/snapshot - reads snapshot-latest from KV
scripts/fetch-odds.js          Scrapes SportyBet / MSport / BetBoro into data/*.json
scripts/find-arbs.js           Cross-bookie arbitrage scanner
scripts/build-match-feed.js    Merges bookmaker dumps into public/matches.json
scripts/sync.js                Legacy API-Football sync (no longer scheduled)
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

## Match feed (SportyBet + MSport)

The site prefers `public/matches.json`, generated from the two bookmaker snapshots:

```bash
npm run build:matches   # node scripts/build-match-feed.js [--days 2] [--no-ai]
```

- Reads `data/sportybet.json` and `data/msport.json` and keeps the 1X2 market.
- Filters to the tracked leagues using `<country> <competition>`, because names such as
  "Championship" and "Premier League" exist in many countries.
- Pairs the same fixture across bookmakers by league + kickoff, then team-name similarity, so
  "Nottm Forest" still merges with "Nottingham Forest".
- Emits the best price per outcome plus a `book_odds` block holding each bookmaker's price,
  which powers the hover breakdown; the tile itself always shows the best price.
- Adds DeepSeek analysis when `DEEPSEEK_API_KEY` is set (`--no-ai` skips it).
- Leaves the existing feed untouched if nothing parses, so a failed run cannot blank the site.

The React app fetches `/matches.json` and only falls back to `/api/snapshot` (KV) when the
feed is missing.

### Scout analysis on the match page

`GET /api/analysis?id=&home=&away=&league=&kickoff=&odds=` ([functions/api/analysis.js](functions/api/analysis.js))
runs a two-step pipeline the first time a fixture is opened:

1. **Scout** — five parallel `POST /v1/tools/search` calls on DeepSeek's Search API, one per angle
   group, each with `after:<yesterday>` and trimmed to the API's 128-character query limit:
   team news/injuries/leaks, underlying form (xG, expected points), manager pressure and
   discipline (sacking talk, VAR, red cards, charges), head-to-head/derby record, and odds
   movement. The top two results per topic become the research context; a failed topic is logged
   and skipped rather than failing the request.
2. **Analyst** — `POST /chat/completions` with that research plus the match odds. The prompt asks
   for plain, friendly English (no betting slang, stat terms explained), explicitly forbids
   inventing facts, and asks for a best bet, two or three alternative angles, and a line on when
   to walk away.

The key stays server-side — calling DeepSeek from the browser would expose it:

```bash
npx wrangler pages secret put DEEPSEEK_API_KEY
```

Behaviour:

- Results are cached in KV under `analysis-<fixtureId>` for six hours. If the search step failed,
  the note is cached for only ten minutes so the next click retries with fresh news.
- Thinking mode is explicitly **disabled** for these calls: DeepSeek enables it by default at
  `high` effort, and its chain-of-thought shares the `max_tokens` budget, which otherwise
  returned an empty `content` once the research context grew.
- A search failure never blocks the write-up: the prompt falls back to
  "No recent news found. Base analysis on odds only."
- The prompt forbids inventing injuries, suspensions, line-ups, transfers or head-to-head records;
  the model may only cite what the articles contain.
- Analyses baked into `matches.json` (via `npm run build:matches` with `DEEPSEEK_API_KEY`) take
  precedence over the on-demand endpoint.
- The response also returns `sources: [{ title, url }]`, which the UI does not render yet.
- `?refresh=1` bypasses the cache read (the UI's **Refresh** button uses it), and the cache key
  carries a version prefix so prompt changes invalidate old notes.

### League table on match pages

`GET /api/standings?league=&home=&away=&season=` ([functions/api/standings.js](functions/api/standings.js))
serves the competition table behind the right sidebar when a match page is open (the home page
keeps showing Top Picks).

- Source: [football-data.org](https://www.football-data.org/) v4. Register for a free token and
  set `FOOTBALL_DATA_ORG_TOKEN` (`.dev.vars` locally, Pages secret in production).
- Tables are cached in KV for 30 minutes per competition and season (their free tier allows
  10 requests/minute).
- The sidebar shows five rows around each team, with both highlighted; an ellipsis marks rows
  trimmed above/below.
- Team names differ between sources ("SC Telstar" vs "Telstar"), so rows are matched with the same
  token-similarity scoring used by the odds feed.
- Mapped competitions: Premier League, Championship, Serie A, Bundesliga, La Liga, Ligue 1,
  Eredivisie, Primeira Liga, Brasileirão, Champions League and World Cup. Cups, the Belgian Pro
  League and the Conference League have no table and return a friendly message instead.

## Keeping odds fresh

`.github/workflows/odds-refresh.yml` runs every 15 minutes (GitHub's minimum is 5; runs can start
late under load) and publishes straight to KV, so the site never redeploys to update odds:

1. `node scripts/fetch-odds.js` → `data/sportybet.json`, `data/msport.json`
2. `node scripts/find-arbs.js` → `public/arbs.json`
3. `node scripts/build-match-feed.js --no-ai` → `public/matches.json`
4. Both files are `PUT` into KV as `feed-matches` and `feed-arbs`

A `concurrency` group stops runs from overlapping, and the job refuses to upload if either feed
is missing or empty, so a failed fetch cannot wipe what is already live.

`functions/api/matches.js` and `functions/api/arbs.js` serve those keys; the client tries
`/api/matches` then `/matches.json`, and `/api/arbs` then `/arbs.json`, so a deployment without
KV data still works. Analysis is left to `/api/analysis` on demand — generating it here would
cost a DeepSeek call per fixture every 15 minutes.

Cadence notes: the repo is public, so Actions minutes are unlimited. KV allows 1,000 writes/day
and this uses 192. GitHub runners use datacenter IPs, so bookmaker sites may block them even when
the scripts work locally — check the first few scheduled runs.

## Sync behaviour and quota safety

The API-Football **free plan** rejects `from`/`to` range queries and season-specific fixture
queries for the current season, so the sync uses global date-scoped fixture calls:

- Fixtures: `/fixtures?date=<day>&timezone=UTC` for today and tomorrow. Each date's response is
  paginated using `paging.total`; fetched pages are combined and deduped by `fixture.id` before
  filtering to the 16 tracked leagues.
- Odds: `/odds?fixture=<id>` is requested for every eligible target-league match in kickoff
  order. All API-Football calls are spaced 6.5 seconds apart. Odds fetching has no arbitrary
  request cap and stops gracefully if the API reports a quota or rate limit.
- Fixture pagination is capped at 32 requests per run; if more pages remain, the log warns how
  many. The total daily API usage depends on fixture pages and eligible matches, so check the
  API quota logs when running frequently.
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
- **No longer scheduled.** `daily-sync.yml` was deleted once the site moved to the 15-minute
  odds refresh; run `node scripts/sync.js` by hand only for API-Football backfills.
- The site polls `/api/snapshot` every 15 minutes and refetches only when a match kicks off within
  the next hour, so late odds/analysis land without any extra API-Football requests.

The `odds_requests` field reports how many per-fixture odds requests were made during the run.

## Routes

- `/` — fixture grid with **Today's Matches** / **Tomorrow's Matches** tabs and a league filter.
  Today hides matches that have already kicked off; tomorrow shows the full slate.
- `/match/:id` — AI detail page (client-side route, served via `public/_redirects`)
