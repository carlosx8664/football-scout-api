# Oddtor (Chrome extension)

Loads the Oddtor arb feed in a side panel, scans tipster slip images with the Bet Builder, opens
both bookmaker fixture pages and types the stakes into each betslip. It **never** clicks
"Place Bet" — that stays a human click.

No build step: plain JS, loaded straight from this folder. `tsc -b` / Vite ignore `extension/`
because `tsconfig.app.json` only includes `src`.

## Load it

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `extension/` folder.
3. Click the extension icon. In the side panel, paste your Pages URL (or press
   *Use open dashboard tab*) and **Save**. Approve the host-permission prompt for a custom domain.
4. Sign in to SportyBet and BetBoro in this Chrome profile. The extension reuses those cookies.

The ☀/☾ button beside **Refresh** switches the panel between dark and light. The choice is stored
in `chrome.storage.local` and restored on open; dark is the default.

## Use it

Pick a row → **Run Autobet**. Both tabs open in one window, load, then pair into Chrome's native
split view (when `chrome.tabs.createSplit` is available) so SportyBet is on the left and BetBoro on
the right. On Chrome builds without that API the two tabs are moved into side-by-side windows
instead — the fill path is identical either way. The market is selected, the price is re-checked and
the stake is typed. Verify both slips yourself, then click Place Bet on each.

**Retry unfilled legs** re-runs only the legs that did not fill, with the odds check bypassed —
use it after you have seen why the first attempt stopped.

## Scan a tipster image

The side panel has two tabs: **Autobet** (feed, stakes, job progress) and **Bet Builder**. Bet
Builder holds the slip-image scanner and, directly below it, the **SmartACCA** card.

Three ways to get a slip in, all on the **Bet Builder** tab:

1. **Paste (usual path).** Press **Win+Shift+S**, drag a box around the slip, then click the panel
   and press **Ctrl+V**. The clipboard image is scanned directly.
2. **Drag.** Drag the image element from Telegram, X, WhatsApp Web or any page onto the drop zone.
3. **Choose.** Drop a saved file or click *Choose…*.

The panel downscales it and posts it to the same `/api/bet-builder/extract` endpoint the dashboard
uses, then lists the matched fixtures with SportyBet/BetBoro links, the SportyBet share code, and a
*Fill BetBoro* button that runs through the existing slip job.

- Paste and file drops carry the bytes, so they need no host permission and work on any site.
- The first time you drag an image from a new host, Chrome asks to read that host. Approving lets
  the panel download the original bytes; a denial leaves the drag URL unusable, so snip or paste
  instead.
- X's `name=small|medium` renditions are upgraded to `name=orig` before download, so the model
  reads the uploaded image rather than the timeline thumbnail.
- Images over 8 MB are rejected by the API; the panel recompresses to a 1600 px JPEG first, so
  that only happens for unusual formats it cannot decode.

Scans show an indeterminate progress bar with elapsed seconds while the vision request runs.

SmartACCA scrapes today's SportyTrader tips — editorial cards plus the "1X2 model" table — across
1X2, double chance, both teams to score and over/under on goals, corners and bookings. Same-game
combos are skipped because they cannot be booked as one leg. It asks the dashboard server's Groq
key for each candidate's estimated win chance and the four best picks, and prices every leg from
SportyBet (the feed for 1X2, SportyBet's own event book for the deeper markets), so the combined
odds and the GHS 22.50 default stake's potential return are real bookable numbers. Fixtures that
have already kicked off are dropped. Each pick shows a red→green bar with Groq's win-chance
percentage beside it.

The 🔃 button pulls a fresh batch. The **Slip** selector sizes it as a double, treble or 4-fold.
**Add to SportyBet** opens the share slip and logs it; **Add to BetBoro** only logs it. Either
action records those legs, so the next refresh ranks the next strongest picks instead of repeating
them. The **Log to** selector chooses the real wallet or Simulation. When fewer than the chosen
number of unused picks are left, the panel says so and offers **Start today over**. Set
`SMART_ACCA_GROQ_API_KEY` as a Cloudflare Pages secret (or in local `.dev.vars`) to enable it; the
key is never sent to the extension.

Groq judges each selection on the SportyTrader tip or model probability, the live SportyBet price
(with the book's implied probability), the market, and — where `FOOTBALL_DATA_ORG_TOKEN` covers the
competition — both teams' league position, points, recent form and goal record. Injuries, team news
and head-to-head are not available to the dashboard, so the prompt forbids Groq from claiming them.
The model is `openai/gpt-oss-120b` (Groq retired `llama-3.3-70b-versatile` on 2026-08-16); set
`SMART_ACCA_GROQ_MODEL` as a Pages secret to pin a different one.

Each matched row shows **STRONG / GOOD / WEAK** instead of the matcher's raw score. That score is
the fixture-matching confidence (team-name similarity, blended with a 1X2 price comparison when one
exists) — a sign of how well the leg matched the feed, not a probability of the bet winning.
STRONG ≥ 0.90, GOOD ≥ 0.80, WEAK ≥ the 0.72 acceptance floor.

## What it will not do

- Markets missing from the translation dictionary — or whose SportyBet card header does not match
  the dictionary's `section` — are reported as `manual only` rather than guessed.
- Sign in, deposit, accept an "odds changed" modal, or click Place Bet.
- Read or store credentials. Requests go to the configured dashboard API; the Groq key stays on
  that server.

## Market dictionaries

`shared/markets.js` (SportyBet) and `shared/betboro-markets.js` (BetBoro) translate the scanner's
market labels (`scripts/find-arbs.js`, e.g. `Over/Under 2.5 Goals`) into where each bookmaker
renders them — the market card header plus the exact outcome tile — so no market text is hardcoded
in a content script and adding a market means adding one entry.

SportyBet sections were taken from its own `factsCenter` market `desc`; BetBoro sections are the
card headers it renders (`BOTH TEAMS TO SCORE`, `TOTAL GOALS OVER/UNDER`, `MATCH RESULT`,
`TOTAL CORNERS OVER/UNDER`, `TOTAL CARDS OVER/UNDER`), with `tab` naming the market tab that has to
be open first (BetBoro only mounts the selected tab).

| Scanner market | SportyBet section | BetBoro section |
| --- | --- | --- |
| `Both Teams to Score` | `GG/NG` | `BOTH TEAMS TO SCORE` |
| `Over/Under {line} Goals` | `Over/Under` | `TOTAL GOALS OVER/UNDER` |
| `Over/Under {line} Corners` | `Corners - Over/Under` | `TOTAL CORNERS OVER/UNDER` |
| `Over/Under {line} Bookings` | `Bookings - Over/Under` | `TOTAL CARDS OVER/UNDER` |
| `Asian Handicap {line}` | `Asian Handicap` | `ASIAN HANDICAP` |
| `1X2` / `Double Chance` / `Draw No Bet` legs | same names | `MATCH RESULT` / `DOUBLE CHANCE` / `DRAW NO BET` |

Entries marked `verified: false` (shots, tackles, throw-ins, half markets, team totals, Asian
handicap) use a header that has not been confirmed against a live page: only an exact header match
is accepted, so a mismatch ends the attempt instead of filling from the wrong card.

An entry may also carry `aliases` — SportyBet's `BTTS Yes`/`BTTS No` legs are selected from the
`GG/NG` card, so the betslip names the card. `matchesMarket()` accepts those spellings
(`GG/NG`, `GG/NG Yes`, `GG`, `Yes`), still rejecting a slip that states the other side
(`GG/NG No`), and both content scripts pass their alias-aware check into `fillSlip`.

Both dictionaries are classic scripts, not ES modules — `chrome.scripting.executeScript({ files })`
cannot load modules — so they publish `globalThis.__markets` / `globalThis.__betboroMarkets` and are
listed before the handler in `manifest.json` and in `background.js`'s `inject()`.

## Layout

| Path | Role |
| --- | --- |
| `manifest.json` | MV3 manifest; host permissions limited to the two books plus Pages/localhost |
| `background.js` | Job state machine, tab orchestration + split-view pairing, badge, panel message router |
| `content/common.js` | DOM helpers shared by both bookie scripts (ported from `scripts/*-autobet.js`) |
| `content/sportybet.js` | Deep-link-first fill: dictionary lookup → section scroll → tile click, then verify/type |
| `content/betboro.js` | Dictionary-driven click path: market tab → market header → outcome tile, then verify/type |
| `content/bridge.js` | Dashboard ⇄ extension relay (`window.postMessage` + `chrome.runtime`) |
| `panel/` | Side panel UI: Autobet/Bet Builder tabs, feed and job views, paste/drag/drop slip scanner |
| `shared/markets.js` | SportyBet market dictionary + alias-aware outcome matcher |
| `shared/betboro-markets.js` | BetBoro market dictionary (tab → section → tile) |
| `shared/stakes.js` | Stake split/rounding shared by the panel preview and the worker |
| `shared/feed.js` | `/api/arbs` reader with two quick retries; `/arbs.json` accepted only when recent and non-empty |

## Dashboard trigger (optional)

`content/bridge.js` announces itself so the React app can start a job without knowing the
extension id:

```js
// dashboard → extension
window.postMessage(
  { source: 'oddtor-dashboard', type: 'AUTOBET_START', requestId: 'abc', arb, totalStake: 100 },
  window.location.origin,
);

// extension → dashboard (also fires once on load as AUTOBET_READY)
window.addEventListener('message', (event) => {
  if (event.data?.source === 'oddtor-autobet') console.log(event.data);
});
```

### Filling a whole slip (Bet Builder)

`AUTOBET_SLIP` takes a list of selections on one bookmaker and types none of the stakes:

```js
window.postMessage(
  {
    source: 'oddtor-dashboard',
    type: 'AUTOBET_SLIP',
    requestId: 'abc',
    legs: [
      // market/outcome are BetBoro dictionary keys — see shared/betslip-betboro.js
      { bookmaker: 'BetBoro', url: 'https://betboro.com.gh/...', market: 'Over/Under 2.5 Goals', outcome: 'Over', label: 'Over 2.5' },
    ],
  },
  window.location.origin,
);
// reply: { source: 'oddtor-autobet', type: 'AUTOBET_SLIP_RESULT', requestId, result: { ok, filled, total, results[] } }
```

The first leg clears the BetBoro betslip (the same verified clear Autobet uses); later legs append.
A missing `stake` means the stake stays empty for the user to fill.
