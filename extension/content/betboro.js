/**
 * BetBoro content script.
 *
 * BetBoro's fixture deep link carries no market/outcome ids, so this is the "click it" path:
 * market tab -> market header -> outcome tile -> betslip. The tab, header and tile text all come
 * from the translation dictionary (`shared/betboro-markets.js`), so no market name is hardcoded
 * here; the walk-up-from-the-header rule is kept so a wrapping container cannot swallow the click.
 */
(() => {
  const A = globalThis.__autobet;
  const M = globalThis.__betboroMarkets;
  if (!A || !M) return;

  const BOOK = 'BetBoro';

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

  const exact = (value) => new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

  /** Opens the market tab the dictionary names. A missing tab is not fatal — the card may be up. */
  function openTab(tab) {
    if (!tab) return false;
    const [found] = findLabels([new RegExp(`^${tab}`, 'i')], { nodes: CLICKABLE, max: 40 });
    if (!found) return false;
    A.deepClick(found.closest(CLICKABLE) ?? found);
    return true;
  }

  function namesOutcome(text, spec) {
    const value = A.textOf(text);
    if (!value) return false;
    return exact(spec.outcome).test(value) || A.textMatches(value, spec.outcome) || A.matchesSide(value, spec.outcome);
  }

  const TILE = '[class*="betting-info" i]';

  /**
   * Column the dictionary outcome sits in, counted left to right inside one market row.
   * BetBoro prints Yes before No, Over before Under, 1 before X before 2, so the position is a
   * reliable fallback when the label text comes back padded or abbreviated.
   */
  function tileIndexFor(outcome) {
    const value = String(outcome ?? '')
      .trim()
      .toLowerCase();
    if (/^yes\b|^over\b|^home win$|^home$|^home or draw/.test(value)) return 0;
    if (/^no\b|^under\b|^draw$|^home or away/.test(value)) return 1;
    if (/^away win$|^away$|^draw or away/.test(value)) return 2;
    return null;
  }

  /**
   * Leaf price tiles inside `scope`, in DOM order.
   *
   * BetBoro nests them (`betting-info` wraps `betting-info-main`), so a plain query returns the
   * row *and* its tiles — which shifted every index by one and clicked "Yes" for a "No" leg.
   * Only nodes that contain no other matched tile, and that carry a two-decimal price, count.
   */
  function cardTiles(scope) {
    const all = [...scope.querySelectorAll(TILE)].filter(A.visible);
    return all.filter(
      (node) =>
        !all.some((other) => other !== node && node.contains(other)) &&
        A.parseOdds(A.textOf(node)) != null,
    );
  }

  /** Tiles that belong to the dictionary outcome's line ("2.5", not "12.5"). */
  function rowTiles(scope, spec) {
    const line = String(spec.outcome).match(/\d+(?:\.\d+)?/)?.[0] ?? null;
    const wanted = line
      ? new RegExp(`(^|[^0-9.])${line.replace('.', '\\.')}([^0-9]|$)`)
      : null;
    return cardTiles(scope).filter((tile) => !wanted || wanted.test(A.textOf(tile)));
  }

  /**
   * Clicks the outcome tile inside the dictionary's market card.
   *
   * The header anchors the search: walk up from it until the ancestor holds the market's tiles.
   * The dictionary outcome's position picks the column (Yes = first, No = second), so padded or
   * abbreviated labels ("No " / "0") no longer stop the click; an exact label match still wins
   * when one exists.
   */
  function selectOutcome(spec) {
    const [header] = findLabels([exact(spec.section)], { max: 60 });
    // Unverified sections only accept the exact header; a loose match could pick the wrong card.
    const [fallback] =
      !header && spec.verified ? findLabels([new RegExp(spec.section, 'i')], { max: 60 }) : [];

    let scope = header ?? fallback ?? null;
    for (let depth = 0; depth < 6 && scope; depth += 1) {
      const tiles = rowTiles(scope, spec);
      if (tiles.length) {
        const labelled = tiles.find((tile) => namesOutcome(tile, spec));
        const index = tileIndexFor(spec.outcome);
        const tile = labelled ?? (index == null ? null : tiles[index]) ?? null;
        if (!tile) return null;

        const odds = A.parseOdds(A.textOf(tile));
        A.deepClick(tile);
        return { tile, odds };
      }
      scope = scope.parentElement;
    }

    return null;
  }

  const BETSLIP_COUNT_AT_START = /^betslip\s*(\d{0,3})(?!\d)/i;

  /**
   * BetBoro keeps the betslip selection count in `#myForm`, which exists even while the panel is
   * hidden: "Betslip1My Bets1" with one selection, "BetslipMy Bets1" when empty. The rendered rows
   * are unmounted while hidden, so this counter is the only evidence that a selection still exists.
   *
   * @returns {{state: 'zero'|'selected'|'unknown', count: number|null, reason: string}}
   */
  function betBoroSlipState() {
    const form = document.querySelector('#myForm');
    if (!form) return { state: 'unknown', count: null, reason: '#myForm not found' };

    const text = A.textOf(form);
    const match = text.match(BETSLIP_COUNT_AT_START);
    if (!match) {
      return {
        state: 'unknown',
        count: null,
        reason: `unrecognised betslip counter "${text.slice(0, 60) || '(empty)'}"`,
      };
    }

    // With no digits the observed layout continues with the next label ("BetslipMy Bets1");
    // anything else ("Betslip(1)") is a layout this parser does not understand.
    if (!match[1] && !/^[a-z]/i.test(text.slice(match[0].length))) {
      return {
        state: 'unknown',
        count: null,
        reason: `unrecognised betslip counter "${text.slice(0, 60)}"`,
      };
    }

    const count = match[1] ? Number(match[1]) : 0;
    return count > 0
      ? { state: 'selected', count, reason: '' }
      : { state: 'zero', count: 0, reason: '' };
  }

  /**
   * Opens the closed BetBoro betslip so its hidden selections can be cleared.
   * Only called when findSlip() is null, so the tab toggle is expected to open — not close — the panel.
   *
   * @returns {Promise<boolean>} whether a slip became visible after the click.
   */
  async function openBetslipPanel() {
    // The tab is navigated just before this runs, so the toggle can still be hydrating (zero-sized).
    const toggle = await A.waitFor(
      () => [...document.querySelectorAll('.tab-button.betslip-btn')].filter(A.visible)[0] ?? null,
      { timeout: 3000, interval: 200 },
    );
    if (!toggle) {
      console.log(`[autobet] ${BOOK} closed betslip: no visible betslip toggle found`);
      return false;
    }

    A.deepClick(toggle);
    const opened = Boolean(await A.waitFor(() => A.findSlip(), { timeout: 5000, interval: 200 }));
    if (!opened) console.log(`[autobet] ${BOOK} closed betslip: toggle clicked but no slip appeared`);
    return opened;
  }

  /**
   * Empties the BetBoro betslip via its own clear-all trash.
   *
   * `.remove_btn` sits in the betslip bar inside `#myForm`, outside `#tab1`, so the slip-scoped
   * removal controls never reach it — and the `.clear-ico` inside the row is decorative. One click
   * empties the whole slip; `clearSlip` then runs as the verifier, because a click alone proves
   * nothing. When the trash is absent (empty slip) this is exactly the old behaviour.
   */
  async function clearBetslip(slip) {
    const [clearAll] = [...document.querySelectorAll('#myForm .remove_btn')].filter(A.visible);
    if (clearAll) {
      A.deepClick(clearAll);
      await A.sleep(400);
    }
    return A.clearSlip(slip);
  }

  async function run(message) {
    const leg = message.leg ?? {};
    const outcome = String(leg.outcome ?? '');
    const market = String(message.arb?.market ?? '');
    const expected = Number(leg.expectedOdds) || 0;
    const tolerance = message.tolerancePct;
    console.log(`[autobet] ${BOOK} fill "${outcome}" stake=${leg.stake} expectedOdds=${expected} market="${market}"`);

    const spec = M.resolveBetboroMarket(market, outcome);
    if (!spec.ok) return { status: 'unsupported', message: spec.reason };

    const matchesOutcome = (slip) => slip && namesOutcome(slip, spec);

    // 0. Start from an empty slip: a leftover selection would ride along with ours.
    const stale = A.findSlip();
    if (stale) {
      const cleared = await clearBetslip(stale);
      console.log(`[autobet] ${BOOK} betslip clear: ${cleared.message}`);
      if (!cleared.ok) return { status: 'failed', message: cleared.message };
      if (cleared.removed) await A.sleep(400);
    }

    let slip = await A.waitFor(() => {
      const candidate = A.findSlip();
      return matchesOutcome(candidate) ? candidate : null;
    }, { timeout: 5000 });

    let tileOdds = null;

    if (!slip) {
      // A closed betslip unmounts its rows, so findSlip() cannot see a selection it still holds.
      // When nothing was visible to clear, the counter is the only evidence: if it reports
      // selections, open the panel and clear them instead of clicking an outcome on top of them.
      if (!stale) {
        const counter = betBoroSlipState();
        if (counter.state === 'unknown') {
          return {
            status: 'failed',
            message: `Could not verify that the BetBoro betslip is empty (${counter.reason}). No new outcome was selected and no stake was entered.`,
          };
        }
        if (counter.state === 'selected') {
          const hidden = (await openBetslipPanel()) ? A.findSlip() : null;
          if (!hidden) {
            return {
              status: 'failed',
              message: `BetBoro holds ${counter.count} selection(s) in a closed betslip, and it could not be opened to clear them. No new outcome was selected and no stake was entered. Open the BetBoro betslip, review it, then run Autobet again.`,
            };
          }

          const cleared = await clearBetslip(hidden);
          console.log(`[autobet] ${BOOK} closed betslip clear: ${cleared.message}`);
          if (!cleared.ok) {
            return {
              status: 'failed',
              message: `${cleared.message} ${counter.count} selection(s) were in the closed betslip. No new outcome was selected and no stake was entered.`,
            };
          }
          if (cleared.removed) await A.sleep(400);
        }
      }

      openTab(spec.tab);
      await A.sleep(900);

      const selected = await A.waitFor(() => selectOutcome(spec), {
        timeout: 15000,
        interval: 600,
      });
      if (!selected) {
        return {
          status: 'failed',
          message: `Could not find "${spec.outcome}" inside "${spec.section}" on ${BOOK}. Nothing filled.`,
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

    const observed = A.readSlipOdds(slip, expected) ?? tileOdds;
    const check = A.oddsCheck(expected, observed, tolerance, message.ignoreOdds);
    if (!check.ok) return { status: 'aborted', observedOdds: observed, message: check.message };

    return A.fillSlip({
      slip,
      stake: leg.stake,
      observedOdds: observed,
      outcome,
      matches: matchesOutcome,
    });
  }

  A.listen(BOOK, run);
})();
