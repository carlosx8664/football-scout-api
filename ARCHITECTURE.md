# ARCHITECTURE.md — football-scout-api ("Oddtor")

> Arbitrage + odds intelligence dashboard for Ghanaian bookmakers, with a full wallet/ledger
> simulation layer. Last reviewed: 2026-10-30.

## 1. App Overview

The app has three jobs:

1. **Odds aggregation** — scrapes six bookmakers (SportyBet, MSport, BetBoro, BoltBet, BetPawa,
   Soccabet), merges them into one fixture feed, and serves it as a match grid with best prices
   per outcome.
2. **Arbitrage detection** — cross-references every bookmaker pair on every shared fixture, across
   1X2, Double Chance, Draw No Bet, Over/Under, BTTS, Asian Handicap, Corners, Bookings and more,
   and surfaces opportunities where the combined implied probability is < 100%. Alerts go to
   Telegram and Web Push.
3. **Bankroll / ledger simulation** — a four-to-six wallet bookmaker model where you log arbs,
   debit stakes, settle results (win / void / cash-out / cancel), track profit, rebalance capital,
   and record human-looking deposits and withdrawals so real accounts don't look automated.

A "simulation mode" toggle keeps a complete parallel set of simulated wallets and bets, isolated
from real data by an `is_simulation` flag on every table.

## 2. Tech Stack

| Layer | Technology |
| --- | --- |
| UI | React 19 + TypeScript, Vite 8, React Router 7, hand-written CSS (no UI framework) |
| Hosting | Cloudflare Pages with Pages Functions (`functions/`) |
| Storage | Cloudflare **KV** (odds feeds, caches) + Cloudflare **D1** (SQLite: wallets, ledgers) |
| Scraping | Node 20 + `axios` (fast books) + Playwright/Chromium (SPA books: BetPawa, Soccabet) |
| Scheduling | Cloudflare Cron Worker → GitHub Actions `workflow_dispatch` (every 15 min) |
| Alerts | Telegram Bot API + Web Push (VAPID, `web-push`) |
| AI | DeepSeek (match analysis + betslip vision), optional Cloudflare AI Gateway |
| Lint | Oxlint |
| ⚠️ Not used | **React Native** — this is a web-only SPA. No mobile app exists. |

## 3. Core Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ GitHub Actions: odds-refresh.yml  (dispatched every 15 min)         │
│                                                                     │
│  fetch-odds.js ─┐                                                   │
│  fetch-betpawa ─┼─→ data/*.json ─→ find-arbs.js ─→ public/arbs.json │
│  fetch-soccabet┘                        │            data/arbs-     │
│                                         │            history.json  │
│  build-match-feed.js ─→ public/matches.json                         │
│                                         │                           │
│  Telegram alert + Web Push (VAPID) ─────┘                           │
│                                         │                           │
│  KV PUT: feed-matches, feed-arbs, feed-arbs-history                 │
└─────────────────────────────────────────┼───────────────────────────┘
                                          ▼
                                   Cloudflare KV
                                          ▲  reads
┌─────────────────────────────────────────┴───────────────────────────┐
│ Cloudflare Pages                                                    │
│                                                                     │
│  React SPA (src/)  ──fetch──→  Pages Functions (functions/api/)      │
│      /arbs, /wallets, /match/:id            │                       │
│                                             ├─→ KV (feeds, caches)  │
│                                             ├─→ D1 (wallets,        │
│                                             │      active_bets,     │
│                                             │      history, …)      │
│                                             └─→ External APIs       │
│                                                 (DeepSeek,          │
│                                                  football-data.org, │
│                                                  SportyBet booking)  │
└─────────────────────────────────────────────────────────────────────┘
```

**Dispatch path:** Cloudflare Cron Worker (`workers/dispatch-trigger/`) fires `*/15 * * * *` and
POSTs to GitHub's `workflow_dispatch` API. `odds-refresh.yml` has no `schedule:` of its own, so a
run can never be duplicated; a `concurrency` group guards against overlap.

**Client fallback chain:** `/api/matches` → `/matches.json`; `/api/arbs` → `/arbs.json`. A
deployment without KV data still renders.

**Circuit breaker:** before publishing, the workflow compares the new match count against the live
KV feed and skips the `feed-matches` upload if the new run has less than half as many matches
(arb feed is still published).

## 4. Major Components

### Frontend — `src/`

| File / folder | Role |
| --- | --- |
| `main.tsx` | Provider stack: `ThemeProvider → SimulationProvider → BankrollProvider → NotificationProvider → App` |
| `App.tsx` | Route switch (`/`, `/arbs`, `/wallets`, `/match/:id`), snapshot loading, league filter |
| `types.ts` | All shared payload/record types (matches, arbs, wallets, bets, history, mug bets, push) |
| `lib/api.ts` | Match/arb feed fetchers with fallbacks; SportyBet share-code POST |
| `lib/bets.ts` | Log arb, fetch active bets, settle, cancel |
| `lib/wallets.ts` | Wallets, balances, transfers, cash flow, `refreshWallets`, `formatGhs`/`formatAmount`, 50-GHS step helpers |
| `lib/history.ts` | Date-range presets + settled-arb fetch |
| `lib/bankroll.ts` | Bankroll plan math (`computePlan`), floor-to-100 per-bookie split (`splitPerWallet`), selected bookies (`selectedBookies`/`hasSplit`), localStorage persistence |
| `lib/notifications.ts` | Alert rule engine, dedupe windows, cool-downs, persistence |
| `lib/mugBets.ts`, `lib/push.ts`, `lib/cooldown.ts`, `lib/theme.ts`, `lib/simulation.ts` | Feature clients/state |
| `components/Header.tsx` | Logo, nav (Arbs · Wallets), simulation toggle, notifications bell, theme toggle, best-arb badge |
| `components/ArbsTable.tsx` | Live + past arb tables, stake scaling/rounding, Ledger checkbox → log arb |
| `components/LogArbModal.tsx` | Pre-filled editable stakes, per-bookie available balance, save to `active_bets` |
| `components/WalletsDashboard.tsx` | `/wallets` layout + single owner of `GET /api/wallets`; wires all wallet panels |
| `components/BankrollPlan.tsx` | Editable bankroll/stake plan split across the selected bookies, per-bookie target, Momo card (plan leftover + net transfers), float warning, **Start afresh** |
| `components/WalletsPanel.tsx` | Live plan split per bookie (bankroll ÷ selected bookies, floored to 100; 0 when unselected), actual-balance portfolio/available cards, selection locked while an arb is in play, Top up / Withdraw prompts validated against Momo |
| `components/RebalancingHints.tsx` | Per-bookie gauges for the selected bookies: name, % of the plan target, progress bar (red well below target, amber near, green at/above) and live balance |
| `components/ActiveBetsLedger.tsx` | Right column: 2 bets per page, Settle + Remove |
| `components/SettleBetModal.tsx` | Settlement wizard: Normal Win / Void / Cash Out |
| `components/CashFlowPanel.tsx` | Deposit/withdrawal ledger (incl. each bookie's opening deposit) with deposited/withdrawn totals and the live planned-deposit figure |
| `components/WalletsHistory.tsx` | `/wallets/history` page: settled history full width, no right sidebar |
| `components/HistoryLedger.tsx` | Settled arbs grouped by day, date filter, weekly outlay, Void/Cash-Out badges |
| `components/MugBetsPanel.tsx` | Tabbed mug-bet entry: **Muggy Acca** (bookie, daily stake, odds) and **Free Bet** (bookie, match, stake, odds + hedge bookie/stake/odds) with a live **Possible Win** (stake × odds) for the free stake and the hedge — both log to `active_bets` |
| `components/ArbCalculator.tsx` | Standalone stake calculator |
| `components/NotificationBell.tsx` + `NotificationProvider.tsx` | Inbox UI + alert engine |
| `components/PushToggle.tsx`, `ThemeToggle.tsx`, `SimulationToggle.tsx`, `SimulationBanner.tsx` | Small global toggles |
| `components/Sidebar.tsx`, `MainFeed.tsx`, `MatchDetail.tsx`, `RightSidebar.tsx`, `LeagueTable.tsx`, `BetBuilder.tsx`, `BestArbBadge.tsx`, `RecycleCooldown.tsx`, `Toast.tsx` | Feed, detail, standings, betslip OCR, misc |
| `styles/base.css`, `styles/dark.css` | Design tokens + dark theme |

### Backend — `functions/api/` (Cloudflare Pages Functions)

| Endpoint | Purpose |
| --- | --- |
| `matches.js` | `GET` — KV `feed-matches`, 404 until the workflow has run |
| `arbs.js` | `GET` — KV `feed-arbs` (+ horizon feed merge), 404 until populated |
| `arbs/share.js` | `POST` — SportyBet booking codes → share URL |
| `analysis.js` | `GET` — DeepSeek match preview w/ live search, KV-cached 6 h |
| `standings.js` | `GET` — league table via football-data.org, KV-cached 30 min |
| `bet-builder/extract.js` | `POST` — betslip screenshot → matched legs + deep links (KV cache by image hash) |
| `wallets.js` | `GET` — wallets, liquidity, profit, cash-flow totals, pending-settlement bookies |
| `wallets/[id].js` | `PATCH` balance · `DELETE` (not used by UI) |
| `wallets/[id]/transfers.js` | `POST` — deposit/withdrawal with no amount cap and no rate limit (top-up limited by the Momo reserve, withdrawal by the balance); moves the Momo reserve the other way |
| `wallets/refresh.js` | `POST` — **Start afresh**: wipes bets/history/cash-flow, funds only the selected bookies (logging their opening deposits), zeroes the rest, resets the transfer-only Momo reserve |
| `wallets/cash-out.js` | `POST` — weekly profit sweep to base target (bypasses per-move caps) |
| `wallets/recycle.js` | `POST` — move capital bookie → bookie (one withdrawal + one deposit, atomic) |
| `transfers.js` | `GET` — cash-flow ledger + totals |
| `active-bets.js` | `GET` list · `POST` log (`kind`: arb / muggy / free; a free bet only debits the hedge; **arbs are refused until a muggy acca is logged today**) |
| `active-bets/[id].js` | `DELETE` — cancel + refund both stakes + zero-profit `cancelled` history row |
| `active-bets/[id]/settle.js` | `POST` — win / void / cash-out settlement with credits batch |
| `history.js` | `GET` — settled arbs by date range + weekly outlay |
| `mug-bets.js`, `mug-bets/[id]/settle.js` | Legacy `mug_bets` ledger (the UI now logs mug bets through `active-bets.js`) |
| `push/key.js`, `subscribe.js`, `unsubscribe.js`, `_store.js` | Web Push VAPID key + KV subscription store |

### Shared — `shared/`

| File | Role |
| --- | --- |
| `wallets.js` | **Central D1 access**: mode parsing, `ensureWallets`, liquidity, cash flow, pending settlement, `walletPayload` |
| `deeplinks.js` | Bookmaker names, `BOOKMAKERS` list, per-bookie URL builders + search fallbacks |
| `teams.js` | `normalizeTeam` — strips FC/SC/United/City/… for cross-bookie name matching |
| `leagues.js` | Single source of truth for the 16 tracked leagues |
| `arb-key.js` | Stable arb identity shared by scanner, push sender and UI |
| `mug-bets.js` | Mug-bet row mapping + totals |
| `sportybet.js`, `betslip-prompt.js`, `betslip-match.js` | Booking API, vision prompt, leg matching |

### Scripts — `scripts/`

`fetch-odds.js` (SportyBet/MSport/BetBoro/BoltBet) · `fetch-betpawa.js` (Playwright + kickoff
parsing) · `fetch-soccabet.js` (isd.js + socket) · `find-arbs.js` (scanner + history + Telegram +
push) · `build-match-feed.js` · `push-notify.js` (Web Push fan-out) · `generate-vapid-keys.js` ·
plus debug/probe utilities (`probe-betboro.js`, `debug-sportybet-markets.js`, `check-*.js`,
`test-scroll.js`, `arb-scraper.js`, `parse-betslip.js`).

### Database — `migrations/`

| File | Contents |
| --- | --- |
| `0001_wallets_and_active_bets.sql` | `wallets` (4 sim @250 + 4 real @0), `active_bets` |
| `0002_history_details.sql` | `history` gains both bookie names/stakes + `total_stake` |
| `0003_history_settlement_type.sql` | `history.settlement_type` (`win`/`void`/`cashout`/`cancelled`) |
| `0004_wallet_transfers.sql` | `wallet_transfers` (deposit/withdrawal ledger) |
| `0005_active_bets_kickoff.sql` | `active_bets.kickoff` |
| `0006_cash_reserve_and_mug_bets.sql` | `cash_reserve`, `mug_bets` (legacy mug ledger) |
| `0007_active_bets_kind.sql` | `active_bets.kind` — `arb` / `muggy` / `free`, so mug bets share the arb ledger |
| `0008_history_kind.sql` | `history.kind` — lets the daily mug-bet gate still see mug bets that already settled |
| `0009_free_bet_flag.sql` | `active_bets.is_free_bet` / `history.is_free_bet` — the free stake is never debited and `total_stake` counts only the hedge |

### Worker — `workers/dispatch-trigger/`

Cloudflare Cron Worker (`*/15 * * * *`) that POSTs to the GitHub `workflow_dispatch` endpoint with
a fine-grained PAT.

## 5. Current State — working

**Pipeline (autonomous):**
- Six bookmakers scraped every 15 minutes; SportyBet/MSport/BetBoro/BoltBet via axios, BetPawa and
  Soccabet via Playwright.
- BetPawa kickoffs parsed from the card (was a fake `Date.now()+1h`) — 51/51 resolved.
- Soccabet integrated: canonical `sel` keys, `0`/`101` sentinel prices rejected, Google-fallback
  deep links.
- Cross-bookie matching by `sr:match:` ID first, then `normalizeTeam(home)|normalizeTeam(away)` with
  a 2-hour kickoff tolerance (covers bucket edges).
- Feeds published to KV with circuit breaker; arb history carried across runs.
- Telegram alerts: percentage stake split, 1,000-GHS scaled example, human-readable kickoff,
  deep links, `--alert-min=1.5` floor, palpable-error (>7%) suppression, one optional caution note.
- Web Push alerts via `sendPushAlerts` inside `find-arbs.js`.

**Frontend:**
- Home feed with today/tomorrow/this-week tabs, league filter, best-price tooltips.
- `/arbs`: live tables with stake scaling + rounding, near-miss mode, Ledger checkbox → Log Arb.
- `/wallets`: Bankroll Plan → My Wallets → Rebalancing Hints (centre); Active Bets (2/page),
  Cash Flow and Mug Bets (340px aside). Settled history lives on its own page,
  `/wallets/history`, which renders the ledger full width without the aside.
- Global simulation toggle + yellow banner; all wallet/bet queries filtered by `is_simulation`.
- Notification inbox with rules: withdrawal >35%, top-up <15% after a 4-hour cool-down and past
  08:00, BetBoro >0, daily profit >100 GHS; per-mode localStorage inboxes.
- Settlement wizard (win/void/cash-out), Remove-and-refund with audit row, history with date
  presets, day grouping and weekly outlay.
- Automatic wallet provisioning for every bookmaker in `BOOKMAKERS`.

**Backend:** all endpoints above deployed and functioning; D1 at migration 0006.

## 6. Known Issues / TODO

### Accounting/model inconsistencies
1. **Two different bankroll denominators.** `RebalancingHints` is now **cash-only**
   (`SUM(balance)`), but `src/lib/notifications.ts:buildAlerts` still uses
   **cash + staked**. The bell can therefore say "top up" while the panel stays silent. Pick one.
2. **Pending-settlement suppression exists only in the hints.** The notification engine has no
   4-hour pending window — it uses its own cool-down, so wording/behaviour differ between bell and panel.
3. **Post-settlement liquidity ≠ recorded profit.** History's `net_profit = payout − both stakes`,
   while wallet movement is `−both debits` at placement and `+payout` at settlement. The *sum*
   reconciles, but any per-bet comparison of "wallet delta" vs "net_profit" won't match by design.

### Legacy rows
4. `active_bets` rows logged before migration **0005** have `kickoff = NULL` → card falls back to
   "Placed <time>".
5. `history` rows settled before **0002** have no bookie names/stakes → render `—` and contribute 0
   to the weekly settled outlay.

### Coverage / data quality
6. **BetPawa joins only ~5 fixtures**, **Soccabet ~4 of 10** — catalogue mismatch (Panama, Jamaica,
   Vietnam, USL leagues the other books don't carry), not a timing bug. May improve at weekends.
7. Soccabet currently emits **1X2 only**, so arb surface is small; deep links are Google fallbacks
   until a real fixture URL is captured.
8. Zero arbs on the board during testing; tightest near-miss was **−1.007%**, i.e. the 6-book spread
   sits inside a 1–2% overround. Expected for mid-week fixtures.

### Ops / environment
9. **Migrations are per-environment.** Forgetting `npm run db:migrate` (prod) or `db:migrate:local`
   produces the "ledger database is missing a recent update" banner across three panels — the most
   frequent failure so far (hit twice: `0003`, `0004`).
10. D1 binding **must** be named `DB` in `wrangler.jsonc`; `"remote": true` is a `wrangler dev` flag,
    not a Pages binding option.
11. Transient Cloudflare API `7403 (account not authorized)` on `--remote` migrations — retry works.
12. Preview deployments share the production `database_id` until `preview_database_id` is set.
13. Rapid successive pushes cause Pages builds to be SIGTERM'd (`exit code -15`, no compiler output).
    Batch commits; retry rather than re-push.

### UX gaps / unimplemented
14. Bankroll plan is **localStorage only** — not synced across devices, and not used by the Arbs
    page's own "Total stake" box (two independent stake inputs).
15. Notification cool-down/low-balance timestamps live in localStorage; clearing site data resets them.
16. `DELETE /api/active-bets/:id` handling in `wallets/[id].js` — the file exposes a `DELETE` that the
    UI no longer calls (cancel now goes through `active-bets/[id].js`); confirm whether it's dead code.
17. Telegram/push delivery has **not been verified end-to-end** — no `TELEGRAM_TOKEN` /
    `TELEGRAM_CHAT_ID` / VAPID keys exist locally, so alerts were only checked by formatting output.
18. Mug bets (muggy accas and free bets) now live in `active_bets` with `kind` set, so they inherit
    Remove/Settle, liquidity and profit accounting. Rows logged earlier in `mug_bets` are legacy and
    are no longer listed by the UI.

### Verification debt
19. No automated tests exist anywhere (no unit, integration or E2E). Validation is `npm run build`
    (`tsc -b` + Vite), `npm run lint` (Oxlint), and manual smoke checks.
20. `npm run lint` shows pre-existing warnings in `scripts/*` (unused vars/catch params) — cosmetic.
21. A PowerShell-driven edit once mangled UTF-8 in `RebalancingHints.tsx` (mojibake `â€"`); repaired,
    but be cautious with non-ASCII edits through shell heredocs.

---

**Three files to read first if you return to this in six months:**
[shared/wallets.js]() (all D1 access),
[src/components/WalletsDashboard.tsx]()
(page wiring + single fetch), and
[scripts/find-arbs.js]() (the whole engine).