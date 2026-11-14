/**
 * SportyBet market translation dictionary.
 *
 * Keys are the arb scanner's own market labels (`scripts/find-arbs.js`), `{line}` marks the
 * handicap/total the label carries. `section` is the exact `span.m-table-header-title` text of
 * the SportyBet market card, taken from the bookmaker's own `factsCenter` market `desc`:
 *
 *   1 -> "1X2"                  10 -> "Double Chance"       11 -> "Draw No Bet"
 *  29 -> "GG/NG"                18 -> "Over/Under"          139 -> "Bookings - Over/Under"
 * 166 -> "Corners - Over/Under" 16 -> "Asian Handicap -2.5"
 *
 * Entries whose section could not be confirmed against a live SportyBet response are marked
 * `verified: false`: they are still looked up, but a header that does not match ends the attempt
 * instead of falling back to a looser match, so a thin market is never filled from the wrong card.
 *
 * Loaded as a classic script (`chrome.scripting.executeScript({ files })` cannot load ES modules),
 * so the dictionary is published on `globalThis.__markets` rather than exported.
 */
(() => {
  if (globalThis.__markets?.version) return;

  /** Over/Under cards share one shape: section title plus "Over 2.5" / "Under 2.5" tiles. */
  const overUnder = (section, options = {}) => ({
    section,
    marketId: options.marketId ?? null,
    verified: options.verified ?? false,
    template: true,
    outcomes: { Over: 'Over {line}', Under: 'Under {line}' },
  });

  const SPORTYBET_MARKETS = {
    'Both Teams to Score': {
      section: 'GG/NG',
      marketId: '29',
      verified: true,
      outcomes: { Yes: 'Yes', No: 'No' },
      // The betslip names the card ("GG/NG") rather than the scanner's "BTTS Yes", so both
      // spellings are accepted when checking that the right leg was selected.
      aliases: {
        Yes: ['GG/NG Yes', 'GG/NG', 'GG', 'Yes', 'BTTS Yes'],
        No: ['GG/NG No', 'GG/NG', 'NG No', 'No', 'BTTS No'],
      },
    },
    'Over/Under {line} Goals': overUnder('Over/Under', { marketId: '18', verified: true }),
    'Over/Under {line} Corners': overUnder('Corners - Over/Under', { marketId: '166', verified: true }),
    'Over/Under {line} Bookings': overUnder('Bookings - Over/Under', { marketId: '139', verified: true }),
    'Over/Under {line} Tackles': overUnder('Tackles - Over/Under'),
    'Over/Under {line} Throw-Ins': overUnder('Throw-Ins - Over/Under'),
    'Over/Under {line} Shots': overUnder('Shots - Over/Under'),
    'Over/Under {line} Shots on Target': overUnder('Shots on Target - Over/Under'),
    '1st Half Over/Under {line} Shots': overUnder('1st Half Shots - Over/Under'),
    '1st Half Over/Under {line} Shots on Target': overUnder('1st Half Shots on Target - Over/Under'),
    'Home Team O/U {line} Goals': overUnder('Home Team Totals'),
    'Away Team O/U {line} Goals': overUnder('Away Team Totals'),
    '1st Half Home O/U {line} Goals': overUnder('1st Half Home Team Totals'),
    '1st Half Away O/U {line} Goals': overUnder('1st Half Away Team Totals'),
    '2nd Half Home O/U {line} Goals': overUnder('2nd Half Home Team Totals'),
    '2nd Half Away O/U {line} Goals': overUnder('2nd Half Away Team Totals'),
    'Home Team O/U {line} Shots': overUnder('Home Team Shots - Over/Under'),
    'Away Team O/U {line} Shots': overUnder('Away Team Shots - Over/Under'),
    'Home Team O/U {line} Shots on Target': overUnder('Home Team Shots on Target - Over/Under'),
    'Away Team O/U {line} Shots on Target': overUnder('Away Team Shots on Target - Over/Under'),
    'Asian Handicap {line}': {
      section: 'Asian Handicap',
      prefix: true,
      marketId: '16',
      verified: true,
      template: true,
      outcomes: { Home: 'Home ({signedLine})', Away: 'Away ({oppositeLine})' },
    },

    // One scanner market, two SportyBet cards: the outcome label says which card the leg is on.
    'Home Win vs Draw/Away (X2)': {
      legs: {
        'Home Win': { section: '1X2', outcome: 'Home' },
        'Draw or Away (X2)': { section: 'Double Chance', outcome: 'Draw or Away' },
      },
    },
    'Away Win vs Home/Draw (1X)': {
      legs: {
        'Away Win': { section: '1X2', outcome: 'Away' },
        'Home or Draw (1X)': { section: 'Double Chance', outcome: 'Home or Draw' },
      },
    },
    'Draw vs Home/Away (12)': {
      legs: {
        Draw: { section: '1X2', outcome: 'Draw' },
        'Home or Away (12)': { section: 'Double Chance', outcome: 'Home or Away' },
      },
    },
    'DNB Home vs Draw/Away (X2)': {
      legs: {
        'Home (DNB)': { section: 'Draw No Bet', outcome: 'Home' },
        'Draw or Away (X2)': { section: 'Double Chance', outcome: 'Draw or Away' },
      },
    },
    'DNB Away vs Home/Draw (1X)': {
      legs: {
        'Away (DNB)': { section: 'Draw No Bet', outcome: 'Away' },
        'Home or Draw (1X)': { section: 'Double Chance', outcome: 'Home or Draw' },
      },
    },
    'Draw No Bet: Home vs Away': {
      marketId: '11',
      legs: {
        'Home (DNB)': { section: 'Draw No Bet', outcome: 'Home' },
        'Away (DNB)': { section: 'Draw No Bet', outcome: 'Away' },
      },
    },
    'Home/Draw vs Draw/Away (1X + X2)': {
      legs: {
        'Home or Draw (1X)': { section: 'Double Chance', outcome: 'Home or Draw' },
        'Draw or Away (X2)': { section: 'Double Chance', outcome: 'Draw or Away' },
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
    // Team totals and half markets lead with the side ("Home Team Over 1.5 Goals").
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
    if (SPORTYBET_MARKETS[market]) return { entry: SPORTYBET_MARKETS[market], line: lineOf(market) };

    for (const [template, entry] of Object.entries(SPORTYBET_MARKETS)) {
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
   * Scanner market + leg outcome -> where SportyBet renders it.
   * @returns {{ok: true, section: string, outcome: string, marketId: string|null, verified: boolean, prefix: boolean}
   *          | {ok: false, reason: string}}
   */
  function resolveSportybetMarket(market, outcome) {
    const key = String(market ?? '').trim();
    const found = lookup(key);
    if (!found) return { ok: false, reason: `"${key}" is not in the SportyBet dictionary.` };

    const { entry, line: marketLine } = found;
    const label = String(outcome ?? '').trim();

    if (entry.legs) {
      const leg = entry.legs[label];
      if (!leg) {
        return { ok: false, reason: `"${label}" is not a leg of ${key} on SportyBet.` };
      }
      return {
        ok: true,
        section: leg.section,
        outcome: leg.outcome,
        marketId: entry.marketId ?? null,
        verified: true,
        prefix: false,
      };
    }

    const side = sideOf(label);
    const template = side ? entry.outcomes[side] : null;
    if (!template) {
      return { ok: false, reason: `"${label}" is not a ${key} outcome on SportyBet.` };
    }

    const line = lineOf(label) ?? marketLine;
    return {
      ok: true,
      section: fill(entry.section, line),
      outcome: fill(template, line),
      marketId: entry.marketId ?? null,
      verified: entry.verified !== false,
      prefix: Boolean(entry.prefix),
    };
  }

  /**
   * Text the betslip may show for this leg: the dictionary's own tile text plus the entry's
   * aliases ("BTTS Yes" is selected from the "GG/NG" card, so the slip says "GG/NG").
   */
  function acceptableLabels(market, outcome) {
    const found = lookup(String(market ?? '').trim());
    const label = String(outcome ?? '').trim();
    const spec = resolveSportybetMarket(market, outcome);
    if (!spec.ok) return [];

    const entry = found?.entry;
    const key = entry?.legs ? label : sideOf(label);
    const extra = (key && entry?.aliases?.[key]) || [];
    return [...new Set([spec.outcome, ...extra])].map(normalize).filter(Boolean);
  }

  const tokenHit = (text, label) => {
    const value = normalize(text);
    if (!value || !label) return false;
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(value);
  };

  /** The labels of every *other* outcome on the same card, so "GG/NG No" cannot pass as Yes. */
  function opposingLabels(market, outcome) {
    const found = lookup(String(market ?? '').trim());
    const entry = found?.entry;
    if (!entry) return [];

    const label = String(outcome ?? '').trim();
    const line = lineOf(label) ?? found.line;
    const other = entry.legs
      ? Object.keys(entry.legs).filter((key) => key !== label)
      : Object.keys(entry.outcomes).filter((key) => key !== sideOf(label));

    return other
      .flatMap((key) => [
        entry.legs ? entry.legs[key].outcome : fill(entry.outcomes[key], line),
        ...(entry.aliases?.[key] ?? []),
      ])
      .map(normalize)
      .filter(Boolean);
  }

  /**
   * Alias-aware outcome check for the content script: true when `text` names this leg using either
   * the dictionary tile or a known alias. Matching is token-based so a bare "GG" cannot be found
   * inside an unrelated word, and a slip that states the *other* side ("GG/NG No") is rejected
   * unless it also carries this leg's own tile text.
   */
  function matchesMarket(text, market, outcome) {
    const spec = resolveSportybetMarket(market, outcome);
    if (!spec.ok) return false;

    const own = acceptableLabels(market, outcome);
    if (!own.some((label) => tokenHit(text, label))) return false;

    // Labels both sides share ("GG/NG") say nothing about Yes vs No, so they are not evidence
    // for the other side either.
    const ownSet = new Set(own);
    const opposing = opposingLabels(market, outcome).some(
      (label) => !ownSet.has(label) && tokenHit(text, label),
    );
    if (!opposing) return true;
    return tokenHit(text, normalize(spec.outcome));
  }

  globalThis.__markets = {
    version: 1,
    SPORTYBET_MARKETS,
    resolveSportybetMarket,
    acceptableLabels,
    matchesMarket,
  };
})();
