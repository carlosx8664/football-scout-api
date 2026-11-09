/**
 * BetBoro content script.
 *
 * BetBoro's fixture deep link carries no market/outcome ids, so this is the "click it" path:
 * market tab -> market header -> outcome tile -> betslip. Ported from
 * `scripts/betboro-autobet.js` (`tagByText` / `waitForTag` / `tagOver25InMarket`), with the
 * innermost-matching-node rule kept so a wrapping container cannot swallow the click.
 */
(() => {
  const A = globalThis.__autobet;
  if (!A) return;

  const BOOK = 'BetBoro';

  const TABS = {
    ou: [/^goals\b/i, /goals\s*\(\d+\)/i],
    result: [/^(1x2|match result|main|result)\b/i, /^(1x2|match result|main|result)\s*\(\d+\)/i],
    btts: [/^(btts|both teams)/i, /both teams to score\s*\(\d+\)/i],
  };

  const MARKET_HEADERS = {
    ou: [/total goals over\s*\/\s*under/i, /over\s*\/\s*under/i],
    result: [/1x2/i, /match result/i, /double chance/i, /draw no bet/i],
    btts: [/both teams to score/i],
  };

  const CLICKABLE = 'button, a, [role="tab"], [role="button"], li, label, [data-testid]';
  const LABELS = 'h1, h2, h3, h4, h5, h6, span, p, div, button';

  /** Innermost visible node whose own text matches, then the nearest clickable ancestor. */
  function findLabels(patterns, { max = 60, scope = document, nodes = LABELS } = {}) {
    return [...scope.querySelectorAll(nodes)]
      .filter((node) => {
        const text = A.textOf(node);
        if (!text || text.length > max) return false;
        if (!patterns.some((pattern) => pattern.test(text))) return false;
        return ![...node.children].some((child) =>
          patterns.some((pattern) => pattern.test(A.textOf(child))),
        );
      })
      .filter(A.visible);
  }

  function clickTab(family) {
    const patterns = TABS[family];
    if (!patterns) return false;
    const [tab] = findLabels(patterns, { nodes: CLICKABLE, max: 40 });
    if (!tab) return false;
    A.deepClick(tab.closest(CLICKABLE) ?? tab);
    return true;
  }

  /**
   * Clicks the outcome tile that belongs to the matching market.
   *
   * The header anchors the search: walk up from it until the ancestor also contains a label
   * naming the outcome, then click that label's tile. This is what keeps the repeated "Over 2.5"
   * labels in other markets out of reach.
   */
  function selectOutcome(family, outcome) {
    const headers = MARKET_HEADERS[family] ?? [];
    const [header] = findLabels(headers, { max: 60 });

    let scope = header ?? document;
    for (let depth = 0; depth < 6 && scope; depth += 1) {
      const found = findLabels([{ test: (text) => A.textMatches(text, outcome) }], {
        scope,
        nodes: 'h6, span, div, p, button',
        max: 30,
      });
      if (found.length) {
        const target = found[found.length - 1];
        const tile =
          target.closest('[class*="betting-info" i], [class*="odd" i], [role="button"], button') ??
          target;
        const odds = A.parseOdds(A.textOf(tile)) ?? A.parseOdds(A.textOf(target));
        A.deepClick(tile);
        return { tile, odds };
      }
      scope = scope.parentElement;
    }

    return null;
  }

  async function run(message) {
    const leg = message.leg ?? {};
    const outcome = String(leg.outcome ?? '');
    const market = String(message.arb?.market ?? '');
    const family = A.marketFamily(market);
    const expected = Number(leg.expectedOdds) || 0;
    const tolerance = message.tolerancePct;

    if (family === 'exotic') {
      return {
        status: 'unsupported',
        message: `"${market}" is not auto-filled on ${BOOK}. Open it manually.`,
      };
    }

    const matchesOutcome = (slip) => slip && A.textMatches(A.textOf(slip), outcome);

    let slip = await A.waitFor(() => {
      const candidate = A.findSlip();
      return matchesOutcome(candidate) ? candidate : null;
    }, { timeout: 5000 });

    let tileOdds = null;

    if (!slip) {
      clickTab(family);
      await A.sleep(900);

      const selected = await A.waitFor(() => selectOutcome(family, outcome), {
        timeout: 15000,
        interval: 600,
      });
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

    const observed = A.parseOdds(A.textOf(slip)) ?? tileOdds;
    const check = A.oddsCheck(expected, observed, tolerance, message.ignoreOdds);
    if (!check.ok) return { status: 'aborted', observedOdds: observed, message: check.message };

    return A.fillSlip({ slip, stake: leg.stake, observedOdds: observed, outcome });
  }

  A.listen(BOOK, run);
})();
