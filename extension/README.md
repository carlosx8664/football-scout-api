# Odds Autobet (Chrome extension)

Loads the Oddtor arb feed in a side panel, opens both bookmaker fixture pages and types the
stakes into each betslip. It **never** clicks "Place Bet" — that stays a human click.

No build step: plain JS, loaded straight from this folder. `tsc -b` / Vite ignore `extension/`
because `tsconfig.app.json` only includes `src`.

## Load it

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `extension/` folder.
3. Click the extension icon. In the side panel, paste your Pages URL (or press
   *Use open dashboard tab*) and **Save**. Approve the host-permission prompt for a custom domain.
4. Sign in to SportyBet and BetBoro in this Chrome profile. The extension reuses those cookies.

## Use it

Pick a row → **Run Autobet**. Both tabs open in one window, load, then pair into Chrome's native
split view (when `chrome.tabs.createSplit` is available) so SportyBet is on the left and BetBoro on
the right. On Chrome builds without that API the two tabs are moved into side-by-side windows
instead — the fill path is identical either way. The market is selected, the price is re-checked and
the stake is typed. Verify both slips yourself, then click Place Bet on each.

**Retry unfilled legs** re-runs only the legs that did not fill, with the odds check bypassed —
use it after you have seen why the first attempt stopped.

## What it will not do

- Markets missing from the translation dictionary — or whose SportyBet card header does not match
  the dictionary's `section` — are reported as `manual only` rather than guessed.
- Sign in, deposit, accept an "odds changed" modal, or click Place Bet.
- Read or store credentials. Nothing leaves the browser except `GET /api/arbs`.

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
| `panel/` | Side panel UI: feed list, stake preview, job progress |
| `shared/markets.js` | SportyBet market dictionary + alias-aware outcome matcher |
| `shared/betboro-markets.js` | BetBoro market dictionary (tab → section → tile) |
| `shared/stakes.js` | Stake split/rounding shared by the panel preview and the worker |
| `shared/feed.js` | `/api/arbs` → `/arbs.json` fallback reader |

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
