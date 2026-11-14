/**
 * SportyBet content script.
 *
 * The arb feed's deep link already carries `marketId`/`outcomeId`, so the market is normally
 * pre-selected and the betslip is on screen. When that pre-selection does not happen, the market
 * is located through the translation dictionary (`shared/markets.js`): the scanner's market name
 * resolves to SportyBet's card header plus the exact tile text, so no market name is hardcoded here.
 *
 * It types the stake and stops. It never touches "Place Bet".
 */
(() => {
  const A = globalThis.__autobet;
  const M = globalThis.__markets;
  if (!A || !M) return;

  const BOOK = 'SportyBet';

  const headerTitles = (wrapper) =>
    [...wrapper.querySelectorAll('span.m-table-header-title')].map(A.textOf);

  const tiles = (scope) =>
    [...scope.querySelectorAll('span.m-table-cell-item, .m-table-cell-item')].filter(A.visible);

  const lineIn = (text) => {
    const body = String(text ?? '').replace(/\b\d+(?:st|nd|rd|th)\b/gi, ' ');
    const hit = body.match(/-?\d+(?:\.\d+)?/);
    return hit ? hit[0] : null;
  };

  function hasTile(wrapper, outcome) {
    const wanted = A.norm(outcome);
    return tiles(wrapper).some((tile) => A.norm(A.textOf(tile)) === wanted);
  }

  /**
   * Cards whose header names `section`. A line market ("Over/Under 2.5") repeats the same header
   * once per line, so the cards that also carry the line — or the wanted tile — come first.
   */
  function cardsFor(section, spec) {
    const wanted = A.norm(section);
    const line = lineIn(spec.outcome);

    const cards = [...document.querySelectorAll('div.m-table__wrapper')]
      .map((wrapper) => {
        const title = headerTitles(wrapper)
          .map(A.norm)
          .find(
            (text) =>
              text === wanted ||
              ((spec.prefix || spec.verified) && text.startsWith(wanted)) ||
              (spec.verified && text.length <= 40 && text.includes(wanted)),
          );
        return title ? { wrapper, title } : null;
      })
      .filter(Boolean);

    const ownLine = (card) => Boolean(line) && card.title.includes(A.norm(line));
    return [
      ...cards.filter(ownLine),
      ...cards.filter((card) => !ownLine(card) && hasTile(card.wrapper, spec.outcome)),
      ...cards.filter((card) => !ownLine(card) && !hasTile(card.wrapper, spec.outcome)),
    ];
  }

  /** Clicks the outcome tile inside the card. Returns the price read off the cell, or null. */
  function clickTile(wrapper, outcome) {
    const wanted = A.norm(outcome);
    const all = tiles(wrapper);
    const item =
      all.find((tile) => A.norm(A.textOf(tile)) === wanted) ??
      all.find((tile) => A.textMatches(A.textOf(tile), outcome));
    if (!item) return null;

    const cell = item.closest('div.m-table-cell') ?? item;
    const odds = A.parseOdds(A.textOf(cell));
    A.deepClick(cell);
    return { cell, odds };
  }

  /** Scrolls the dictionary's section into view, then clicks the dictionary's outcome tile. */
  async function selectFromDictionary(market, outcome) {
    const spec = M.resolveSportybetMarket(market, outcome);
    if (!spec.ok) return { spec };

    const card = cardsFor(spec.section, spec)[0] ?? null;
    if (!card) return { spec, missingSection: true };

    card.wrapper.scrollIntoView({ block: 'center', inline: 'center' });
    await A.sleep(300);

    const clicked = await A.waitFor(() => clickTile(card.wrapper, spec.outcome), { timeout: 5000 });
    return { spec, card, clicked };
  }

  async function run(message) {
    const leg = message.leg ?? {};
    const outcome = String(leg.outcome ?? '');
    const market = String(message.arb?.market ?? '');
    const tolerance = message.tolerancePct;

    const expected = Number(leg.expectedOdds) || 0;
    console.log(`[autobet] ${BOOK} fill "${outcome}" stake=${leg.stake} expectedOdds=${expected} market="${market}"`);
    // Alias-aware: "BTTS Yes" is selected from the "GG/NG" card, so the slip names the card.
    const matchesOutcome = (slip) => {
      if (!slip) return false;
      const text = A.textOf(slip);
      return M.matchesMarket(text, market, outcome) || A.matchesSide(text, outcome) || A.textMatches(text, outcome);
    };

    // 0. Start from an empty slip: a leftover selection would ride along with ours.
    const stale = A.findSlip();
    if (stale && (await A.clearSlip(stale))) await A.sleep(400);

    // 1. The deep link usually selected the market already.
    let slip = await A.waitFor(() => {
      const candidate = A.findSlip();
      return matchesOutcome(candidate) ? candidate : null;
    }, { timeout: 8000 });

    let tileOdds = null;

    // 2. Otherwise translate the market and click it ourselves.
    if (!slip) {
      const { spec, missingSection, clicked } = await selectFromDictionary(market, outcome);

      if (!spec.ok) return { status: 'unsupported', message: spec.reason };
      if (missingSection) {
        return {
          status: 'failed',
          message: `Could not find the "${spec.section}" market on ${BOOK}. Nothing filled.`,
        };
      }
      if (!clicked) {
        return {
          status: 'failed',
          message: `Could not find "${spec.outcome}" inside "${spec.section}" on ${BOOK}. Nothing filled.`,
        };
      }

      tileOdds = clicked.odds;
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
    const observed = A.readSlipOdds(slip, expected) ?? tileOdds;
    const check = A.oddsCheck(expected, observed, tolerance, message.ignoreOdds);
    if (!check.ok) return { status: 'aborted', observedOdds: observed, message: check.message };

    // 4. Type the stake and stop.
    return A.fillSlip({ slip, stake: leg.stake, observedOdds: observed, outcome, matches: matchesOutcome });
  }

  A.listen(BOOK, run);
})();
