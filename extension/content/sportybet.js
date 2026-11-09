/**
 * SportyBet content script.
 *
 * The arb feed's deep link already carries `marketId`/`outcomeId`, so the market is normally
 * pre-selected and the betslip is on screen. Only when that pre-selection does not happen do we
 * click the outcome cell ourselves, scoped to the market wrapper that owns the matching header —
 * the same scoping `scripts/sportybet-autobet.js` uses to keep the many "Over 2.5" labels apart.
 *
 * It types the stake and stops. It never touches "Place Bet".
 */
(() => {
  const A = globalThis.__autobet;
  if (!A) return;

  const BOOK = 'SportyBet';

  /** Header titles (`span.m-table-header-title`) that identify each supported market family. */
  const HEADERS = {
    ou: [/^over\s*\/\s*under/i],
    result: [/^1x2$/i, /^double chance$/i, /^draw no bet$/i, /^match result$/i, /^main$/i],
    btts: [/^both teams to score/i],
  };

  function wrappers(family) {
    const patterns = HEADERS[family] ?? [];
    return [...document.querySelectorAll('div.m-table__wrapper')].filter((wrapper) => {
      const titles = [...wrapper.querySelectorAll('span.m-table-header-title')].map(A.textOf);
      return titles.some((title) => patterns.some((pattern) => pattern.test(title)));
    });
  }

  /**
   * Clicks the outcome cell for `outcome` inside the market wrapper.
   * Returns the price read off the cell, or null when nothing was clicked.
   */
  function selectOutcome(family, outcome) {
    const scopes = family === 'exotic' ? [document] : wrappers(family);
    for (const scope of scopes) {
      const items = [...scope.querySelectorAll('span.m-table-cell-item, .m-table-cell-item')]
        .filter((item) => A.visible(item) && A.textMatches(A.textOf(item), outcome));
      const item = items[0];
      if (!item) continue;

      const cell = item.closest('div.m-table-cell') ?? item;
      const odds = A.parseOdds(A.textOf(cell));
      A.deepClick(cell);
      return { cell, odds };
    }
    return null;
  }

  async function run(message) {
    const leg = message.leg ?? {};
    const outcome = String(leg.outcome ?? '');
    const market = String(message.arb?.market ?? '');
    const family = A.marketFamily(market);
    const tolerance = message.tolerancePct;

    const expected = Number(leg.expectedOdds) || 0;
    const matchesOutcome = (slip) => slip && A.textMatches(A.textOf(slip), outcome);

    // 1. The deep link usually selected the market already.
    let slip = await A.waitFor(() => {
      const candidate = A.findSlip();
      return matchesOutcome(candidate) ? candidate : null;
    }, { timeout: 8000 });

    let tileOdds = null;

    // 2. Otherwise pick it ourselves.
    if (!slip) {
      if (family === 'exotic') {
        return {
          status: 'unsupported',
          message: `"${market}" is not auto-filled on ${BOOK}. Open it manually.`,
        };
      }
      const selected = selectOutcome(family, outcome);
      if (!selected) {
        return {
          status: 'failed',
          message: `Could not find "${outcome}" in the ${family.toUpperCase()} market on ${BOOK}.`,
        };
      }
      tileOdds = selected.odds;
      slip = await A.waitFor(() => {
        const candidate = A.findSlip();
        return matchesOutcome(candidate) ? candidate : null;
      }, { timeout: 20000 });
    }

    if (!slip) {
      const anySlip = A.findSlip();
      return {
        status: 'failed',
        message: anySlip
          ? `Betslip opened but does not show "${outcome}". Nothing filled.`
          : 'Betslip did not open. Nothing filled.',
      };
    }

    // 3. Verify the price before typing anything.
    const observed = A.parseOdds(A.textOf(slip)) ?? tileOdds;
    const check = A.oddsCheck(expected, observed, tolerance, message.ignoreOdds);
    if (!check.ok) return { status: 'aborted', observedOdds: observed, message: check.message };

    // 4. Type the stake and stop.
    return A.fillSlip({ slip, stake: leg.stake, observedOdds: observed, outcome });
  }

  A.listen(BOOK, run);
})();
