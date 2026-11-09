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

- Cricket/booking-code style markets, corners, cards, shots, tackles, throw-ins, team totals and
  Asian handicaps: reported as `manual only` rather than guessed.
- Sign in, deposit, accept an "odds changed" modal, or click Place Bet.
- Read or store credentials. Nothing leaves the browser except `GET /api/arbs`.

## Layout

| Path | Role |
| --- | --- |
| `manifest.json` | MV3 manifest; host permissions limited to the two books plus Pages/localhost |
| `background.js` | Job state machine, tab orchestration + split-view pairing, badge, panel message router |
| `content/common.js` | DOM helpers shared by both bookie scripts (ported from `scripts/*-autobet.js`) |
| `content/sportybet.js` | Deep-link-first fill: verify betslip, check price, type stake |
| `content/betboro.js` | Click path: market tab → market header → outcome tile, then verify/type |
| `content/bridge.js` | Dashboard ⇄ extension relay (`window.postMessage` + `chrome.runtime`) |
| `panel/` | Side panel UI: feed list, stake preview, job progress |
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
