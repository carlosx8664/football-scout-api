/**
 * BetBoro market translation dictionary.
 *
 * Same contract as `shared/markets.js` (SportyBet): scanner market label -> the market card header
 * BetBoro renders, plus the outcome tile inside it. `tab` is the fixture-page market tab that has
 * to be open before the card exists in the DOM (BetBoro only mounts the selected tab's markets).
 *
 * BetBoro renders a price as `<div class="betting-info-main"><h6>Over 2.5</h6><h6>1.58</h6></div>`,
 * so the header is the anchor the content script walks up from — several markets repeat the same
 * "Over 2.5" label.
 *
 * Loaded as a classic script (`chrome.scripting.executeScript({ files })` cannot load ES modules),
 * so the dictionary is published on `globalThis.__betboroMarkets` rather than exported.
 */
(() => {
  if (globalThis.__betboroMarkets?.version) return;

  const overUnder = (section, options = {}) => ({
    section,
    tab: options.tab ?? null,
    verified: options.verified ?? false,
    template: true,
    outcomes: { Over: 'Over {line}', Under: 'Under {line}' },
  });

  const BETBORO_MARKETS = {
    'Both Teams to Score': {
      section: 'BOTH TEAMS TO SCORE',
      tab: 'BTTS',
      verified: true,
      outcomes: { Yes: 'Yes', No: 'No' },
    },
    // Bet Builder vocabulary (`shared/betslip-betboro.js`): plain 1X2 and double chance.
    'Match Result': {
      tab: '1X2',
      verified: true,
      legs: {
        Home: { section: 'MATCH RESULT', outcome: 'Home' },
        Draw: { section: 'MATCH RESULT', outcome: 'Draw' },
        Away: { section: 'MATCH RESULT', outcome: 'Away' },
      },
    },
    'Double Chance': {
      tab: '1X2',
      verified: true,
      legs: {
        'Home or Draw': { section: 'DOUBLE CHANCE', outcome: 'Home or Draw' },
        'Home or Away': { section: 'DOUBLE CHANCE', outcome: 'Home or Away' },
        'Draw or Away': { section: 'DOUBLE CHANCE', outcome: 'Draw or Away' },
      },
    },
    'Over/Under {line} Goals': overUnder('TOTAL GOALS OVER/UNDER', { tab: 'GOALS', verified: true }),
    'Over/Under {line} Corners': overUnder('TOTAL CORNERS OVER/UNDER', { tab: 'CORNERS', verified: true }),
    'Over/Under {line} Bookings': overUnder('TOTAL CARDS OVER/UNDER', { tab: 'CARDS', verified: true }),
    'Over/Under {line} Shots': overUnder('TOTAL SHOTS OVER/UNDER'),
    'Over/Under {line} Shots on Target': overUnder('TOTAL SHOTS ON TARGET OVER/UNDER'),
    'Over/Under {line} Tackles': overUnder('TOTAL TACKLES OVER/UNDER'),
    'Over/Under {line} Throw-Ins': overUnder('TOTAL THROW-INS OVER/UNDER'),
    'Asian Handicap {line}': {
      section: 'ASIAN HANDICAP',
      tab: '1X2',
      verified: false,
      template: true,
      outcomes: { Home: 'Home {signedLine}', Away: 'Away {oppositeLine}' },
    },
    // One scanner market, two BetBoro cards: the outcome label says which card the leg is on.
    'Home Win vs Draw/Away (X2)': {
      tab: '1X2',
      legs: {
        'Home Win': { section: 'MATCH RESULT', outcome: 'Home' },
        'Draw or Away (X2)': { section: 'DOUBLE CHANCE', outcome: 'Draw or Away' },
      },
    },
    'Away Win vs Home/Draw (1X)': {
      tab: '1X2',
      legs: {
        'Away Win': { section: 'MATCH RESULT', outcome: 'Away' },
        'Home or Draw (1X)': { section: 'DOUBLE CHANCE', outcome: 'Home or Draw' },
      },
    },
    'Draw vs Home/Away (12)': {
      tab: '1X2',
      legs: {
        Draw: { section: 'MATCH RESULT', outcome: 'Draw' },
        'Home or Away (12)': { section: 'DOUBLE CHANCE', outcome: 'Home or Away' },
      },
    },
    'DNB Home vs Draw/Away (X2)': {
      tab: '1X2',
      legs: {
        'Home (DNB)': { section: 'DRAW NO BET', outcome: 'Home' },
        'Draw or Away (X2)': { section: 'DOUBLE CHANCE', outcome: 'Draw or Away' },
      },
    },
    'DNB Away vs Home/Draw (1X)': {
      tab: '1X2',
      legs: {
        'Away (DNB)': { section: 'DRAW NO BET', outcome: 'Away' },
        'Home or Draw (1X)': { section: 'DOUBLE CHANCE', outcome: 'Home or Draw' },
      },
    },
    'Draw No Bet: Home vs Away': {
      tab: '1X2',
      legs: {
        'Home (DNB)': { section: 'DRAW NO BET', outcome: 'Home' },
        'Away (DNB)': { section: 'DRAW NO BET', outcome: 'Away' },
      },
    },
    'Home/Draw vs Draw/Away (1X + X2)': {
      tab: '1X2',
      legs: {
        'Home or Draw (1X)': { section: 'DOUBLE CHANCE', outcome: 'Home or Draw' },
        'Draw or Away (X2)': { section: 'DOUBLE CHANCE', outcome: 'Draw or Away' },
      },
    },
  };

  const SIDE_ALIASES = [
    [/^over\b/, 'Over'],
    [/^under\b/, 'Under'],
    [/^yes$/, 'Yes'],
    [/^no$/, 'No'],
    [/^btts yes$/, 'Yes'],
    [/^btts no$/, 'No'],
    [/^home win$/, 'Home'],
    [/^away win$/, 'Away'],
    [/^home\s*\(/, 'Home'],
    [/^away\s*\(/, 'Away'],
    [/^home or draw/, 'Home or Draw'],
    [/^home or away/, 'Home or Away'],
    [/^draw or away/, 'Draw or Away'],
    [/\bover\b/, 'Over'],
    [/\bunder\b/, 'Under'],
  ];

  const normalize = (value) =>
    String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

  /** First number in the label, ignoring ordinals so "1st Half Over 0.5 Shots" reads 0.5. */
  const lineOf = (value) => {
    const text = String(value ?? '').replace(/\b\d+(?:st|nd|rd|th)\b/gi, ' ');
    const hit = text.match(/-?\d+(?:\.\d+)?/);
    return hit ? Number(hit[0]) : null;
  };

  const fill = (template, line) => {
    const value = line == null ? null : Number(line);
    const signed = value == null || !Number.isFinite(value)
      ? ''
      : `${value < 0 ? '-' : '+'}${Math.abs(value)}`;
    const opposite = value == null || !Number.isFinite(value)
      ? ''
      : `${value < 0 ? '+' : '-'}${Math.abs(value)}`;
    return String(template)
      .replace(/\{oppositeLine\}/g, opposite)
      .replace(/\{signedLine\}/g, signed)
      .replace(/\{line\}/g, value == null ? '' : String(value));
  };

  /** Exact key first, then the `{line}` templates ("Over/Under 8.5 Corners"). */
  function lookup(market) {
    if (BETBORO_MARKETS[market]) return { entry: BETBORO_MARKETS[market], line: lineOf(market) };

    for (const [template, entry] of Object.entries(BETBORO_MARKETS)) {
      if (!template.includes('{line}')) continue;
      const pattern = new RegExp(
        `^${template
          .split('{line}')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('(-?\\d+(?:\\.\\d+)?)')}$`,
        'i',
      );
      const hit = market.match(pattern);
      if (hit) return { entry, line: Number(hit[1]) };
    }

    return null;
  }

  function sideOf(outcome) {
    const label = normalize(outcome);
    for (const [pattern, side] of SIDE_ALIASES) if (pattern.test(label)) return side;
    return null;
  }

  /**
   * Scanner market + leg outcome -> where BetBoro renders it.
   * @returns {{ok: true, tab: string|null, section: string, outcome: string, verified: boolean}
   *          | {ok: false, reason: string}}
   */
  function resolveBetboroMarket(market, outcome) {
    const key = String(market ?? '').trim();
    const found = lookup(key);
    if (!found) return { ok: false, reason: `"${key}" is not in the BetBoro dictionary.` };

    const { entry, line: marketLine } = found;
    const label = String(outcome ?? '').trim();

    if (entry.legs) {
      const leg = entry.legs[label];
      if (!leg) return { ok: false, reason: `"${label}" is not a leg of ${key} on BetBoro.` };
      return {
        ok: true,
        tab: entry.tab ?? null,
        section: leg.section,
        outcome: leg.outcome,
        verified: true,
      };
    }

    const side = sideOf(label);
    const template = side ? entry.outcomes[side] : null;
    if (!template) return { ok: false, reason: `"${label}" is not a ${key} outcome on BetBoro.` };

    const line = lineOf(label) ?? marketLine;
    return {
      ok: true,
      tab: entry.tab ?? null,
      section: fill(entry.section, line),
      outcome: fill(template, line),
      verified: entry.verified !== false,
    };
  }

  globalThis.__betboroMarkets = { version: 1, BETBORO_MARKETS, resolveBetboroMarket };
})();
