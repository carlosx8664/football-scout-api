# football-scout-api

A football scouting dashboard: upcoming fixtures across 18 competitions (top-5 European
leagues plus Primeira Liga, Eredivisie, Belgian Pro League, EFL Championship, Brasileirão,
Süper Lig, Danish Superliga, Champions League, Conference League, EFL Cup, FA Cup, World Cup and
Friendlies) for **today and tomorrow**, match-winner odds from API-Football, and a friendly AI
scout preview per match built from DeepSeek search plus the prices the odds pipeline already
fetched.

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
| Hosting | Cloudflare Pages (Functions + KV + D1) |
| Sync job | GitHub Actions + a Node 20 script using `axios` |
| Fixtures/odds | [API-Football v3](https://www.api-football.com/) |
| AI | [DeepSeek](https://api-docs.deepseek.com/), optionally via Cloudflare AI Gateway |
| Lint | Oxlint |

## Project layout

```
shared/leagues.js              Single source of truth for the 16 tracked leagues
shared/deeplinks.js            Bookmaker names + verified per-fixture deep links
shared/teams.js                Team-name normalisation for matching/deduping
shared/betslip-prompt.js       Vision prompt + JSON contract for betslip extraction
shared/betslip-match.js        Resolves extracted betslip legs against the match feed
shared/wallets.js              Mode-scoped wallet + liquidity queries for the wallet Functions
.github/workflows/odds-refresh.yml  Scrape odds, build feeds, publish to KV
workers/dispatch-trigger/      Cloudflare Cron Worker that dispatches the workflow every 15 min
functions/api/matches.js       GET /api/matches - KV feed-matches (odds refresh output)
functions/api/arbs.js          GET /api/arbs - KV feed-arbs (arbitrage output)
functions/api/analysis.js      GET /api/analysis - on-demand DeepSeek preview with live search + odds comparison
functions/api/standings.js     GET /api/standings - league table via football-data.org
functions/api/bet-builder/extract.js  POST /api/bet-builder/extract - screenshot -> matched legs
functions/api/wallets.js       GET /api/wallets - wallets + available liquidity for one mode
functions/api/wallets/[id].js  PATCH /api/wallets/:id - log a deposit / withdrawal
functions/api/wallets/reset.js POST /api/wallets/reset - simulation wallets back to 1,000 GHS
functions/api/active-bets.js  POST /api/active-bets - log a two-leg arb into the ledger
functions/api/active-bets/[id]/settle.js  POST - settle a bet, move the result to history
functions/api/history.js      GET /api/history - settled arbs by date range + weekly outlay
migrations/                    D1 schema + seed (wallets, active_bets)
scripts/fetch-odds.js          Scrapes SportyBet / MSport / BetBoro / BoltBet into data/*.json
scripts/find-arbs.js           Cross-bookie arbitrage scanner
scripts/build-match-feed.js    Merges bookmaker dumps into public/matches.json
src/App.tsx                    Route switch, feed loading, upcoming + league filters
src/components/                Header, Sidebar, MainFeed, RightSidebar, MatchDetail, WalletsPanel (+ CSS)
src/lib/                       Fetch helper, formatting, wallet API client, simulation mode
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

### 2. Create the D1 database

Wallet management and simulation mode read `wallets` / `active_bets` from D1 (binding `DB`).

```bash
npx wrangler d1 create football-scout-db
```

Copy the returned `database_id` into the `d1_databases` entry in [`wrangler.jsonc`](./wrangler.jsonc)
(replacing the placeholder `00000000-0000-0000-0000-000000000000`), then apply the schema:

```bash
npm run db:migrate:local   # local SQLite, used by `wrangler pages dev`
npm run db:migrate         # production database
```

Both commands apply every file in `migrations/` in order, so re-running them after adding a
migration (e.g. `0002_history_details.sql`, which adds the leg/stake columns `History` displays)
is safe.

The migration seeds four wallets per mode: `is_simulation = 1` at 250 GHS each (the "Reset
Simulation Wallets to 1,000 GHS" target) and `is_simulation = 0` at 0 GHS.

### 3. Add GitHub repository secrets

| Secret | Where to get it |
| --- | --- |
| `CF_ACCOUNT_ID` | Cloudflare dashboard → any zone/Workers overview (right-hand account id) |
| `CF_KV_NAMESPACE_ID` | Output of the `kv namespace create` command above |
| `CF_API_TOKEN` | Cloudflare → My Profile → API Tokens → create a token with **Workers KV Storage: Edit** (scoped to your account) |

Pages Functions need two more, set as Pages secrets (not Actions secrets):

```bash
npx wrangler pages secret put DEEPSEEK_API_KEY        # match analysis + bet-builder vision
npx wrangler pages secret put FOOTBALL_DATA_ORG_TOKEN # league tables
```

Pages deploys come from Cloudflare's Git integration, not a GitHub Actions workflow, so there is
no deploy job to add these to. They live on the Pages project: **Pages → your project →
Settings → Variables and secrets**, or the `wrangler pages secret put` commands above. Preview
deployments need their own copy unless you mark the secret for *All environments*.

Add the Actions ones under **Settings → Secrets and variables → Actions → New repository secret**.

### 4. Publish the feeds

Actions → **Odds refresh** → *Run workflow*, or locally:

```bash
node scripts/fetch-odds.js            # data/sportybet.json, data/msport.json
node scripts/find-arbs.js             # public/arbs.json
node scripts/build-match-feed.js --no-ai   # public/matches.json
```

The workflow uploads both files to KV; until it has run once, the site falls back to the JSON
files committed under `public/`.

## Local development

```bash
npm install
npm run preview   # builds + serves the Pages app (Functions + local KV) on :8788
npm run dev       # Vite on :5173, proxies /api -> :8788
```

To work with fresh data locally, run the three scripts above and then load the app — `npm run
dev` serves `public/` directly, so no KV seeding is needed.

`/api/wallets` needs its D1 tables: run `npm run db:migrate:local` once before the first `npm run
preview`. `npm run dev` proxies `/api` to `:8788`, so run `preview` alongside it when working on
wallets.

Other scripts: `npm run build`, `npm run lint`, `npm run deploy`.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/matches` | Match feed from KV (`feed-matches`); 404 until the workflow has run |
| `GET /api/arbs` | Arbitrage feed from KV (`feed-arbs`), including tracked arb history; 404 until the workflow has run |
| `GET /api/analysis` | On-demand DeepSeek note with live search plus odds comparison, cached 6 h per fixture and price set |
| `GET /api/standings` | League table window for a fixture, from football-data.org |
| `POST /api/bet-builder/extract` | Betslip screenshot → extracted legs matched to the feed, with SportyBet/MSport/BetBoro deep links (cached 24 h per image hash) |
| `GET /api/wallets` | Wallets + available liquidity for one mode (`?simulation=1` or `0`), plus total and today's realised profit, from D1 |
| `PATCH /api/wallets/:id` | Set a wallet balance (`balance`) or apply a `delta`, scoped to that mode's `is_simulation` |
| `POST /api/wallets/reset` | Reset the four simulation wallets to 250 GHS each (1,000 GHS total) |
| `POST /api/active-bets` | Log a two-leg arb: debits both stakes from the bookie wallets and inserts the bet, as one batch. `profit_percent` is recomputed server-side and `is_simulation` follows the UI toggle |
| `GET /api/active-bets` | Unsettled bets for one mode (`?simulation=1` or `0`), newest first |
| `POST /api/active-bets/:id/settle` | `{ outcome }` → `win` (`winner`) pays `stake × odds`; `void` (`voided`, plus `remaining`/`cashOutAmount` for a single cancelled leg) refunds the cancelled stake(s); `cashout` (`winner`, `cashOutAmount`) credits the manual amount. Writes `history` (with `settlement_type`), deletes the bet |
| `GET /api/history` | Settled arbs for one mode (`?simulation=1&from=YYYY-MM-DD&to=YYYY-MM-DD`), plus weekly outlay (active stakes + stakes settled since Monday) |

`/api/matches` returns the payload produced by `scripts/build-match-feed.js`:

```jsonc
{
  "status": "success",
  "date": "2026-10-23",
  "window": { "from": "2026-10-23", "to": "2026-10-24" },
  "generated_at": "2026-10-23T18:05:04.000Z",
  "match_count": 57,
  "matches": [
    {
      "fixture": { "id": 1234, "date": "2026-10-23T19:00:00.000Z" },
      "sr_id": "sr:match:72478654",
      "book_ids": { "betboro": { "regionId": "16", "competitionId": "92", "betBoroId": "91668574" } },
      "league": { "id": 39, "name": "Premier League", "logo": "..." },
      "teams": { "home": { "name": "...", "logo": "..." }, "away": { "name": "...", "logo": "..." } },
      "goals": null,
      "odds": [{ "value": "Home", "odd": "1.80" }],
      "book_odds": { "home": { "books": { "SportyBet": 1.80, "MSport": 1.85, "BetBoro": 1.78, "BoltBet": 1.90, "BetPawa": 1.82 }, "best": 1.90, "bookmaker": "BoltBet" } },
      "ai_analysis": null
    }
  ]
}
```

The client tries `/api/matches` first, then falls back to `/matches.json`, so a deployment
without KV data still renders.

## Match feed (SportyBet + MSport + BetBoro + BoltBet + BetPawa)

The match feed is generated from the bookmaker snapshots:

```bash
npm run build:matches   # node scripts/build-match-feed.js [--days 2] [--no-ai]
```

- Reads `data/sportybet.json`, `data/msport.json` and `data/betboro.json`, keeping the 1X2 market.
- Filters to the tracked leagues using `<country> <competition>`, because names such as
  "Championship" and "Premier League" exist in many countries.
- Joins the same fixture across bookmakers on the Sportradar id (`sr:match:…`), which all three
  quote. League + kickoff + team-name similarity ("Nottm Forest" vs "Nottingham Forest") is only
  a fallback for events without an id.
- Attaches BoltBet and BetPawa 1X2 prices after the merge (they carry no Sportradar id, so they
  are joined by team names; BoltBet is also confirmed by kickoff). Every book that quotes an
  outcome ends up in the breakdown, not just the three with Sportradar ids.
- Emits the best price per outcome plus a `book_odds` block. Each outcome carries
  `{ books: { <bookmaker>: price }, best, bookmaker }`, so the hover breakdown lists however many
  books quote it while the tile always shows the best price. Adding a book recalculates `best`
  and the `odds` array.
- Carries the Sportradar id through as `sr_id` on every match, which is what the bet-builder uses
  to open the fixture on SportyBet / MSport (`shared/deeplinks.js`).
- Adds a `book_ids.betboro` block (`regionId`, `competitionId`, `betBoroId`) when BetBoro quoted
  the fixture; its deep-link URL needs those three ids as well.
- Crests come from whichever bookmaker has them: MSport team icons, otherwise BetBoro's
  `participant_logos`, otherwise the card renders without a crest.
- Adds DeepSeek analysis when `DEEPSEEK_API_KEY` is set (`--no-ai` skips it).
- Leaves the existing feed untouched if nothing parses, so a failed run cannot blank the site.

The React app fetches `/api/matches`, falling back to `/matches.json` when KV is empty.

### Scout analysis on the match page

`GET /api/analysis?id=&home=&away=&league=&kickoff=&odds=&books=&sr=` ([functions/api/analysis.js](functions/api/analysis.js))
runs a two-step pipeline the first time a fixture is opened:

1. **Scout** — seven parallel `POST /v1/tools/search` calls on DeepSeek's Search API, one per
   angle group, each with `after:<yesterday>` and trimmed to the API's 128-character query limit:
   injuries/suspensions, predicted lineups and leak rumours, dressing-room and manager fallout,
   home form, away form, head-to-head/derby record, and odds movement. The top two results per
   topic become the research context; a failed topic is logged and skipped rather than failing
   the request. In parallel the function reads the prices the odds pipeline already fetched
   (`/api/arbs` → `arbs.json`, written by `scripts/find-arbs.js`) and keeps the markets for this
   fixture, with the best price and bookmaker per outcome.
2. **Analyst** — `POST /chat/completions` with that research, the 1X2 prices, the per-bookmaker
   1X2 comparison sent by the UI (`books`), and the extra-market board. The prompt asks for plain,
   friendly English (no betting slang, stat terms explained), explicitly forbids inventing facts
   or prices, and asks for at least three paragraphs: team news and lineup leaks, home form versus
   away power plus dressing-room mood, then the betting view naming two or three markets with
   their price and bookmaker, the one worth staking, the one to leave, and when to walk away.

The key stays server-side — calling DeepSeek from the browser would expose it:

```bash
npx wrangler pages secret put DEEPSEEK_API_KEY
```

Behaviour:

- Results are cached in KV under `analysis-<version>-<fixtureId>-<priceTag>` for six hours; the
  price tag is a short hash of the odds sent, so a price change forces a fresh write-up. If the
  search step failed, the note is cached for only ten minutes so the next click retries with fresh
  news.
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

## Bet builder

The **Bet Builder** in the home page's right sidebar (under Top Picks) turns a betslip
screenshot into matched fixtures with deep links, through `POST /api/bet-builder/extract`:

1. The browser downscales the image to ≤1600 px and re-encodes it as JPEG at 0.85
   (`src/lib/betBuilder.ts`), so a 4 MB screenshot uploads at 150–400 KB.
2. The Function caches the extraction in KV by SHA-256 of the image (`betslip:v2:<hash>`, 24 h),
   then calls `deepseek-flash` with a strict `json_object` prompt (`shared/betslip-prompt.js`).
   DeepSeek rejects `json_schema`, so the shape is spelled out in the prompt. The prompt
   deliberately ignores the source bookmaker — a slip from bet365 or Pinnacle is converted to
   **our** local books, so no branding warning is ever raised.
3. `shared/betslip-match.js` resolves each transcribed leg against `feed-matches` — token-aware
   fuzzy team matching with the slip's price as a confirming signal (78/22). The price only
   weighs in for 1X2 legs, because `book_odds` carries no other market. The token gate is what
   keeps "Manchester United" off "Manchester City": `normalizeTeam` strips both `united` and
   `city`, so the stripped names alone are not enough. Club-form words that never separate two
   teams (`BK`, `Boldklub`, `SL`, …) are ignored on both sides, which is what lets "Odense BK"
   match "Odense Boldklub".
4. Matched legs are mapped to SportyBet booking ids (`toSportyBetSelections`): 1X2 by side,
   `Total Goals`/`Over-Under` (line taken from the selection, "Over 1.5"), Double Chance,
   Draw No Bet and BTTS. Team-total and other unlisted markets are skipped rather than guessed,
   so the share code can never book a different bet than the screen shows.
5. Every hit carries a link for each local book — `links.sportybet` / `links.msport` /
   `links.betpawa` / `links.boltbet` / `links.betboro` from `shared/deeplinks.js`, which tries the
   full slug path (`…/football/{league}/{home}_vs_{away}/sr:match:{id}`), then the bare Sportradar
   id, then a Google site search (rendered with a 🔍 icon in the UI). BetBoro, BoltBet and BetPawa
   fixture pages need their own ids, so `scripts/build-match-feed.js` attaches them as
   `book_ids` (BoltBet joined by team names + kickoff, BetPawa by names only — its dump has no
   kickoff and is today-only).
6. SportyBet is the only book we can load a slip into. Each matched leg carries its own `booking`
   payload, so "Add to Slip" opens `POST /api/arbs/share` for just the ticked legs; with nothing
   ticked the panel falls back to the share link minted for the whole scan. Other books stay
   deep links — they expose no booking API.

```
POST /api/bet-builder/extract    multipart/form-data, field "image"
  → 200  { bookmaker, warnings, matched[], unresolved[], cached, stats }
  → 400  no image          413  over 8 MB        415  not PNG/JPEG/WebP/GIF
  → 502/504 vision failure                     503  DEEPSEEK_API_KEY missing
```

`unresolved[]` echoes the leg with a `reason` (`missing-teams`, `no-candidates`,
`low-confidence`, `ambiguous`) plus up to three `candidates`, so the UI can offer a manual picker.
The same image is never billed twice: the extraction cache is keyed on the image hash, not on the
fixture feed, and matching re-runs against the live feed on every request so links stay fresh.

Limits: 8 MB per image, enforced server-side from `File.size` before the bytes are read; the
client downscales further. Requires `DEEPSEEK_API_KEY` as a Pages secret (see step 2 above).

## Keeping odds fresh

`.github/workflows/odds-refresh.yml` runs every 15 minutes (GitHub's minimum is 5; runs can start
late under load) and publishes straight to KV, so the site never redeploys to update odds:

1. Restore `feed-arbs-history` from KV into `data/arbs-history.json`
2. `node scripts/fetch-odds.js` → `data/sportybet.json`, `data/msport.json`
3. `node scripts/find-arbs.js` → `public/arbs.json` (with `arbs` + `history`) and `data/arbs-history.json`
4. `node scripts/build-match-feed.js --no-ai` → `public/matches.json`
5. The files are `PUT` into KV as `feed-matches`, `feed-arbs` and `feed-arbs-history`

`history` holds every arb seen since the start of today (`--history-days`, default 0), with the first
price seen, the latest pre-kickoff price and the profit at each. That is what the Past Arbs
table renders; `arbs` stays limited to matches that have not kicked off.

A `concurrency` group stops runs from overlapping, and the job refuses to upload if either feed
is missing or empty, so a failed fetch cannot wipe what is already live.

`functions/api/matches.js` and `functions/api/arbs.js` serve those keys; the client tries
`/api/matches` then `/matches.json`, and `/api/arbs` then `/arbs.json`, so a deployment without
KV data still works. Analysis is left to `/api/analysis` on demand — generating it here would
cost a DeepSeek call per fixture every 15 minutes.

Cadence notes: the repo is public, so Actions minutes are unlimited. KV allows 1,000 writes/day
and this uses 192. GitHub runners use datacenter IPs, so bookmaker sites may block them even when
the scripts work locally — check the run logs if a feed comes back empty.

### Reliable trigger: Cloudflare Cron

GitHub's `schedule` is best-effort. Measured on this repo, a `1 0,12 * * *` cron actually ran at
03:31 and 16:31 — hours late — and the 15-minute cron produced no scheduled runs at all.
`workers/dispatch-trigger/` is a small Worker whose Cron Trigger dispatches the workflow instead:

```bash
cd workers/dispatch-trigger

# Fine-grained PAT scoped to this repo with "Actions: Read and write".
npx wrangler secret put GH_DISPATCH_TOKEN --config wrangler.jsonc
# Optional shared secret for the manual endpoint.
npx wrangler secret put TRIGGER_KEY --config wrangler.jsonc

cd ../.. && npm run worker:deploy
```

- Cron Trigger: `*/15 * * * *` (UTC). Cloudflare allows 5 per account on the free plan, and the
  job is a single `fetch()` so it stays well inside the 10 ms CPU allowance.
- Manual test: `curl -X POST "https://oddtor-dispatch-trigger.<subdomain>.workers.dev/?key=<TRIGGER_KEY>"`.
- `odds-refresh.yml` has no `schedule:` of its own — the Worker is the only trigger, so a run can
  never be duplicated. Its `concurrency` group still guards against overlap.
- Secrets stay in Cloudflare; nothing is shared with a third-party scheduler.
- The `GH_DISPATCH_TOKEN` has no expiry, so rotate it manually if it is ever exposed.

## Routes

- `/` — fixture grid with **Today's Matches** / **Tomorrow's Matches** tabs and a league filter.
  Today hides matches that have already kicked off; tomorrow shows the full slate. The right
  sidebar carries **Top Picks** and the **Bet Builder** (betslip screenshot → matches).
- `/match/:id` — AI detail page (client-side route, served via `public/_redirects`)
- `/arbs` — live + past arbitrage tables. Each live arb has a **Ledger** checkbox that opens the
  **Log Arb** modal: the computed stakes are pre-filled and can be rounded by hand, and "Save to
  Ledger" inserts them into `active_bets` with `is_simulation` set from the current mode.
- `/wallets` — **My Wallets**: D1 balances for the current mode, click-to-edit deposits/withdrawals,
  available liquidity (cash in the wallets — stakes are debited when a bet is logged), total profit
  (SUM of `history` net profit) and the simulation reset button. The **Active Bets** column on the
  right lists every unsettled bet with a **Settle** button that opens a wizard: **Normal Win**,
  **Void / Refund** (choose the cancelled leg(s); if one leg survives, say whether it won, lost or
  you cashed out) or **Cash Out** (pick the bookie and enter the amount). Each path shows the
  wallet credits and net result before confirming. A **Rebalancing Hints** panel between the two
  shows each bookie's share of the portfolio (cash + stakes in play) and flags top-ups (< 15%,
  sized to reach 25%, rounded up to the next 50 GHS and only when > 20 GHS), withdrawals (> 40%)
  and any BetBoro balance. Between 08:00 and 10:00 local time it also shows the **Morning Check**
  funding summary. The main column ends with **History**, listing settled arbs grouped by day
  with a date filter, per-day totals, a yellow *Void* / *Cash Out* badge (with amber net figures)
  and the week's total outlay (active stakes + stakes settled since Monday).

**Simulation mode** is the switch in the header (on by default, remembered in `localStorage`).
While it is on, a yellow `🧪 SIMULATION MODE ACTIVE` banner sits under the header and every wallet
query filters `is_simulation = 1`; switching it off filters `is_simulation = 0` instead.

**Dark mode** is the `Dark` switch beside it. The choice is stored in `localStorage` under
`oddtor:theme` (falling back to `prefers-color-scheme`) and applied as `data-theme="dark"` on
`<html>`, which `src/styles/dark.css` uses to override the design tokens and the few components
that hard-code a light surface.

**Wallet accounting.** Logging an arb debits each stake from its bookie wallet immediately, so
`available liquidity = SUM(wallets.balance)` at all times — the cash that is actually sitting in
the bookie accounts. Settling only credits the winning bookie with `winning stake × winning odds`
and records `net_profit = payout − both stakes` in `history`, so the wallet movement across a
bet's life (both debits at placement, payout at settlement) equals the recorded profit exactly.

**Notifications.** The bell in the header (`NotificationBell` + `NotificationProvider`) keeps an
inbox per mode, persisted in `localStorage`. Alerts are rebuilt from `GET /api/wallets` on mount,
on mode switch, and whenever a payload arrives from a wallet edit, reset, logged arb or
settlement; `buildAlerts` in `src/lib/notifications.ts` applies the rules:

| Alert | Trigger |
| --- | --- |
| 🔴 Withdraw from [bookie] | cash share of the portfolio (cash + staked) > 35% |
| 🟡 Consider topping up [bookie] | cash share < 15%, only once the shortfall has lasted 4 h **and** the local hour is ≥ 08:00; at most one per day |
| 🚨 BetBoro Warning | BetBoro cash > 0 (always) |
| 🎯 Daily Goal Reached | `dailyProfit` (history settled today) > 100 GHS |

Cool-down state (when each bookie first fell below 15%) is kept per mode in `localStorage`, so
logging a bet never triggers an instant top-up ping — the nudge waits for the 4-hour cool-down
and the morning cutoff.

Duplicates are suppressed for an hour unless the number moved by ≥ 5 percentage points (share
alerts) or ≥ 100 GHS (cash alerts). Clicking a notification dismisses it; "Mark all as read"
clears the badge.
