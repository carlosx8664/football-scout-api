// scripts/find-arbs.js
//
// Cross-bookie arbitrage scanner: SportyBet <-> MSport <-> BetBoro (2-outcome arbs only).
//
// How it works
//  1. Both bookies use Sportradar event IDs ("sr:match:72221344"), so fixtures are
//     matched by eventId. No team-name guessing.
//  2. Every market we understand is turned into "selections" with a simple key,
//     e.g. 1X2:H, DC:X2, DNB:A, BTTS:Y, OU:2.5:O
//  3. Complementary selections are paired (Over 2.5 + Under 2.5, Home + X2, ...).
//     Each pair is checked with the two legs on DIFFERENT bookies.
//  4. Anything with profit above MIN_PROFIT is written to public/arbs.json.
//
// Usage
//   node scripts/find-arbs.js                  real odds (boost = 1.00)
//   node scripts/find-arbs.js --boost=1.05     TEST ONLY: multiplies MSport odds
//   node scripts/find-arbs.js --near=10        also print the 10 closest misses
//   node scripts/find-arbs.js --stake=500      stake split shown per arb (default 100)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const SPORTY_FILE = path.join(DATA_DIR, 'sportybet.json');
const MSPORT_FILE = path.join(DATA_DIR, 'msport.json');
const BETBORO_FILE = path.join(DATA_DIR, 'betboro.json');
const OUT_FILE = path.resolve(__dirname, '..', 'public', 'arbs.json');

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const BOOST = Number(opt('boost', '1'));        // test-only boost applied to MSport odds
const MIN_PROFIT = Number(opt('min', '0'));     // only keep arbs above this %
const NEAR = Number(opt('near', '0'));          // print N closest misses
const TOTAL_STAKE = Number(opt('stake', '100'));

if (!Number.isFinite(BOOST) || BOOST <= 0) {
  console.error('Invalid --boost value');
  process.exit(1);
}

const SPORTY = 'SportyBet';
const MSPORT = 'MSport';
const BETBORO = 'BetBoro';

// ---------------------------------------------------------------------------
// Market parsing -> selections
// Market IDs are the standard Sportradar ones used by both bookies:
//   1 = 1X2, 10 = Double Chance, 11 = Draw No Bet, 18 = Over/Under, 29 = GG/NG
// ---------------------------------------------------------------------------
const clean = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9.]/g, '');
const num = (x) => {
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : null;
};

function readMarket(m) {
  const found = [];
  if (!m || !Array.isArray(m.outcomes)) return found;
  if (m.status != null && Number(m.status) !== 0) return found; // suspended/closed market

  const id = String(m.id);

  for (const o of m.outcomes) {
    if (!o || o.isActive === 0) continue;
    const odds = num(o.odds);
    if (odds === null || odds <= 1) continue;

    // SportyBet labels outcomes with "desc", MSport with "description"
    const label = clean(o.desc ?? o.description);
    const oid = String(o.id);
    let key;

    if (id === '1') {
      key = { home: '1X2:H', draw: '1X2:D', away: '1X2:A' }[label]
        ?? { 1: '1X2:H', 2: '1X2:D', 3: '1X2:A' }[oid];
    } else if (id === '10') {
      key = {
        '1x': 'DC:1X', homeordraw: 'DC:1X',
        '12': 'DC:12', homeoraway: 'DC:12',
        x2: 'DC:X2', draworaway: 'DC:X2',
      }[label];
    } else if (id === '11') {
      key = { home: 'DNB:H', away: 'DNB:A', 1: 'DNB:H', 2: 'DNB:A' }[label]
        ?? { 4: 'DNB:H', 5: 'DNB:A' }[oid];
    } else if (id === '29') {
      key = { yes: 'BTTS:Y', no: 'BTTS:N' }[label];
    } else if (id === '18') {
      const mt = label.match(/^(over|under)(\d+(?:\.\d+)?)$/);
      // only .5 lines are true 2-way (whole-number lines can push/refund)
      if (mt && mt[2].endsWith('.5')) key = `OU:${mt[2]}:${mt[1] === 'over' ? 'O' : 'U'}`;
    }

    if (key) found.push([key, odds]);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Load a bookie file -> Map(eventId -> event)
// ---------------------------------------------------------------------------
function loadBookie(file, bookie) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const events = new Map();
  const typeCounts = {};

  for (const t of raw?.data?.tournaments ?? []) {
    for (const e of t.events ?? []) {
      if (!e.eventId) continue;

      const sel = {};
      for (const m of e.markets ?? []) {
        for (const [key, odds] of readMarket(m)) {
          if (key in sel) continue;
          sel[key] = bookie === MSPORT ? odds * BOOST : odds;
          const type = key.split(':')[0];
          typeCounts[type] = (typeCounts[type] ?? 0) + 1;
        }
      }

      const isSporty = bookie === SPORTY;
      events.set(e.eventId, {
        eventId: e.eventId,
        home: isSporty ? e.homeTeamName : e.homeTeam,
        away: isSporty ? e.awayTeamName : e.awayTeam,
        kickoff: isSporty ? e.estimateStartTime : e.startTime,
        tournament: isSporty ? (e?.sport?.category?.tournament?.name ?? t.name) : (e.tournament ?? t.tournament),
        notStarted: Number(e.status ?? 0) === 0,
        sel,
      });
    }
  }
  return { events, typeCounts };
}

// ---------------------------------------------------------------------------
// BetBoro: `{ fixtures: [...] }`, markets keyed by name
// ---------------------------------------------------------------------------
const betBoroPrice = (node) => {
  if (!node || (node.status && node.status !== 'available')) return null;
  const p = num(node.price);
  return p !== null && p > 1 ? p : null;
};

function loadBetBoro(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const events = new Map();
  const typeCounts = {};

  for (const f of raw?.fixtures ?? []) {
    if (!f?.eventId) continue;

    const sel = {};
    const add = (key, price) => {
      if (!key || price === null || key in sel) return;
      sel[key] = price;
      const type = key.split(':')[0];
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    };

    const result = f.markets?.match_result ?? {};
    add('1X2:H', betBoroPrice(result['0']));
    add('1X2:D', betBoroPrice(result['1']));
    add('1X2:A', betBoroPrice(result['2']));

    const dc = f.markets?.double_chance ?? {};
    add('DC:1X', betBoroPrice(dc['0'])); // "1 or X"
    add('DC:12', betBoroPrice(dc['1'])); // "1 or 2"
    add('DC:X2', betBoroPrice(dc['2'])); // "X or 2"

    const btts = f.markets?.both_teams_to_score ?? {};
    add('BTTS:Y', betBoroPrice(btts['0']));
    add('BTTS:N', betBoroPrice(btts['1']));

    for (const [line, node] of Object.entries(f.markets?.total_goals ?? {})) {
      if (!line.endsWith('.5')) continue; // whole-number lines can push
      add(`OU:${line}:O`, betBoroPrice(node?.['0']));
      add(`OU:${line}:U`, betBoroPrice(node?.['1']));
    }

    events.set(f.eventId, {
      eventId: f.eventId,
      home: f.home,
      away: f.away,
      kickoff: f.kickoff,
      tournament: `${f.region ?? ''} · ${f.competition ?? ''}`.trim(),
      notStarted: Number(f.kickoff) > Date.now(),
      sel,
    });
  }

  return { events, typeCounts };
}

// ---------------------------------------------------------------------------
// Pairs: two selections that together cover every possible result
// ---------------------------------------------------------------------------
const RESULT = ['H', 'D', 'A'];

const FIXED_PAIRS = [
  { a: '1X2:H', b: 'DC:X2', scen: RESULT, market: 'Home Win vs Draw/Away (X2)' },
  { a: '1X2:A', b: 'DC:1X', scen: RESULT, market: 'Away Win vs Home/Draw (1X)' },
  { a: '1X2:D', b: 'DC:12', scen: RESULT, market: 'Draw vs Home/Away (12)' },
  // DNB Home refunds on a draw, X2 wins on a draw -> every result is covered
  { a: 'DNB:H', b: 'DC:X2', scen: RESULT, market: 'DNB Home vs Draw/Away (X2)' },
  { a: 'DNB:A', b: 'DC:1X', scen: RESULT, market: 'DNB Away vs Home/Draw (1X)' },
  // Both refunded on a draw: no loss on a draw, profit if either team wins
  { a: 'DNB:H', b: 'DNB:A', scen: RESULT, profitScen: ['H', 'A'], market: 'Draw No Bet: Home vs Away', note: 'Draw = both stakes refunded (profit only if a team wins)' },
  { a: 'BTTS:Y', b: 'BTTS:N', scen: ['Y', 'N'], market: 'Both Teams to Score' },
];

const LABELS = {
  '1X2:H': 'Home Win', '1X2:D': 'Draw', '1X2:A': 'Away Win',
  'DC:1X': 'Home or Draw (1X)', 'DC:12': 'Home or Away (12)', 'DC:X2': 'Draw or Away (X2)',
  'DNB:H': 'Home (DNB)', 'DNB:A': 'Away (DNB)',
  'BTTS:Y': 'BTTS Yes', 'BTTS:N': 'BTTS No',
};
const labelOf = (key) => {
  if (LABELS[key]) return LABELS[key];
  const [, line, side] = key.split(':'); // OU:2.5:O
  return `${side === 'O' ? 'Over' : 'Under'} ${line}`;
};

// What a leg pays back (per 1 staked) for a given scenario
function payout(key, odds, scen) {
  const parts = key.split(':');
  const type = parts[0];
  const sel = parts[parts.length - 1];
  switch (type) {
    case '1X2': return sel === scen ? odds : 0;
    case 'DC': return sel.includes({ H: '1', D: 'X', A: '2' }[scen]) ? odds : 0;
    case 'DNB': return scen === 'D' ? 1 : (sel === scen ? odds : 0);
    case 'BTTS': return sel === scen ? odds : 0;
    case 'OU': return sel === scen ? odds : 0;
    default: return 0;
  }
}

function evaluate(pair, oa, ob) {
  const ia = 1 / oa;
  const ib = 1 / ob;
  const shareA = ia / (ia + ib); // stake split that equalises the two "main" results
  const shareB = 1 - shareA;

  const returns = {};
  for (const s of pair.scen) {
    returns[s] = shareA * payout(pair.a, oa, s) + shareB * payout(pair.b, ob, s);
  }
  const basis = pair.profitScen ?? pair.scen;
  const profitPct = (Math.min(...basis.map((s) => returns[s])) - 1) * 100;
  return { profitPct, shareA, shareB };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const sporty = loadBookie(SPORTY_FILE, SPORTY);
  const msport = loadBookie(MSPORT_FILE, MSPORT);
  const betboro = loadBetBoro(BETBORO_FILE);

  const sources = [
    { name: SPORTY, book: sporty },
    { name: MSPORT, book: msport },
    { name: BETBORO, book: betboro },
  ];

  for (const { name, book } of sources) {
    console.log(`${name.padEnd(10)} events: ${book.events.size}`);
  }
  if (BOOST !== 1) {
    console.log(`⚠️  TEST MODE: MSport odds multiplied by ${BOOST}. Results are NOT real.`);
  }

  const fmtCounts = (c) => Object.entries(c).map(([k, v]) => `${k} ${v}`).join(' | ') || 'none';
  console.log(`\nSelections read`);
  for (const { name, book } of sources) {
    console.log(`  ${name.padEnd(10)} ${fmtCounts(book.typeCounts)}`);
  }

  const sportyHasMore = Object.keys(sporty.typeCounts).some((t) => t !== '1X2');
  if (!sportyHasMore) {
    console.log(
      '\n⚠️  SportyBet data only contains 1X2. BTTS / Over-Under / Double Chance / DNB cannot be\n' +
      '    compared until fetch-odds.js asks SportyBet for more markets (see marketId in the URL).'
    );
  }

  // One record per fixture, holding each bookmaker's selections.
  const fixtures = new Map();
  for (const { name, book } of sources) {
    for (const ev of book.events.values()) {
      if (!ev.notStarted) continue; // skip live / started games
      const record = fixtures.get(ev.eventId) ?? { event: ev, books: {} };
      record.books[name] = ev.sel;
      fixtures.set(ev.eventId, record);
    }
  }

  const arbs = [];
  const evals = [];
  let matched = 0;
  let pairsChecked = 0;

  for (const { event, books } of fixtures.values()) {
    const names = Object.keys(books);
    if (names.length < 2) continue; // an arb needs two bookmakers
    matched++;

    const lines = new Set();
    for (const name of names) {
      for (const k of Object.keys(books[name])) {
        if (k.startsWith('OU:')) lines.add(k.split(':')[1]);
      }
    }
    const pairs = [...FIXED_PAIRS];
    for (const line of lines) {
      pairs.push({
        a: `OU:${line}:O`, b: `OU:${line}:U`, scen: ['O', 'U'],
        market: `Over/Under ${line} Goals`,
      });
    }

    for (const pair of pairs) {
      // Each ordered pair of different bookmakers, one leg on each.
      for (const bookA of names) {
        for (const bookB of names) {
          if (bookA === bookB) continue;
          const oa = books[bookA][pair.a];
          const ob = books[bookB][pair.b];
          if (!oa || !ob) continue;
          pairsChecked++;

          const { profitPct, shareA, shareB } = evaluate(pair, oa, ob);
          const record = {
            eventId: event.eventId,
            home: event.home,
            away: event.away,
            tournament: event.tournament,
            kickoff: event.kickoff,
            market: pair.market,
            profitPct: Number(profitPct.toFixed(3)),
            legs: [
              { bookmaker: bookA, outcome: labelOf(pair.a), odds: Number(oa.toFixed(2)), stake: Number((TOTAL_STAKE * shareA).toFixed(2)) },
              { bookmaker: bookB, outcome: labelOf(pair.b), odds: Number(ob.toFixed(2)), stake: Number((TOTAL_STAKE * shareB).toFixed(2)) },
            ],
          };
          if (pair.note) record.note = pair.note;

          evals.push(record);
          if (profitPct > MIN_PROFIT) arbs.push(record);
        }
      }
    }
  }

  arbs.sort((x, y) => y.profitPct - x.profitPct);

  console.log(`\nFixtures matched by eventId: ${matched}`);
  console.log(`Cross-bookie pairs checked:  ${pairsChecked}`);
  console.log(`Arbs found:                  ${arbs.length}\n`);

  const printArb = (a) => {
    console.log(`  ${a.home} vs ${a.away}  →  ${a.profitPct}%  [${a.market}]  (${a.tournament})`);
    for (const l of a.legs) {
      console.log(`     ${l.bookmaker}: ${l.outcome} @ ${l.odds.toFixed(2)}  (stake ${l.stake})`);
    }
    if (a.note) console.log(`     note: ${a.note}`);
  };

  if (arbs.length) {
    console.log('💰 Top opportunities:');
    arbs.slice(0, 10).forEach(printArb);
    if (BOOST === 1 && arbs[0].profitPct > 10) {
      console.log('\n⚠️  Anything above ~10% on real odds is usually a stale price or a data mismatch. Verify on both sites before betting.');
    }
  } else if (BOOST === 1) {
    console.log('No arbs right now with real odds. That is normal: the books are priced tightly.');
  }

  if (NEAR > 0) {
    console.log(`\nClosest ${NEAR} near-misses:`);
    evals
      .filter((r) => r.profitPct <= MIN_PROFIT)
      .sort((x, y) => y.profitPct - x.profitPct)
      .slice(0, NEAR)
      .forEach(printArb);
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    boostApplied: BOOST,
    boostTarget: BOOST !== 1 ? MSPORT : null,
    stats: {
      matched,
      pairsChecked,
      bookEvents: Object.fromEntries(sources.map(({ name, book }) => [name, book.events.size])),
    },
    arbs,
  }, null, 2));
  console.log(`\nWrote ${OUT_FILE}`);
}

main();