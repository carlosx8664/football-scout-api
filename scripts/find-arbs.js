// scripts/find-arbs.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, '..', 'data');

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const FILE_SUFFIX = opt('suffix', '');

const SPORTY_FILE = path.join(DATA_DIR, `sportybet${FILE_SUFFIX}.json`);
const MSPORT_FILE = path.join(DATA_DIR, `msport${FILE_SUFFIX}.json`);
const BETBORO_FILE = path.join(DATA_DIR, `betboro${FILE_SUFFIX}.json`);
const BOLTBET_FILE = path.join(DATA_DIR, `boltbet${FILE_SUFFIX}.json`);
const BETPAWA_FILE = path.join(DATA_DIR, `betpawa${FILE_SUFFIX}.json`);
const OUT_FILE = path.resolve(__dirname, '..', 'public', opt('out', `arbs${FILE_SUFFIX}.json`));

// Arb history: every opportunity ever seen, so the Past Arbs table survives kickoff.
// The workflow restores this file from KV before each run and uploads it afterwards.
// Only yesterday and today are kept; older entries are dropped on every run.
const HISTORY_FILE = path.resolve(DATA_DIR, opt('history', 'arbs-history.json'));
const HISTORY_DAYS = Number(opt('history-days', '1'));
const HISTORY_LIMIT = Number(opt('history-limit', '500'));

/** Start of the day `days` before today, local time. */
const historyCutoff = (nowMs, days = HISTORY_DAYS) => {
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  return start.getTime() - days * 86_400_000;
};

const BOOST = Number(opt('boost', '1'));        
const MIN_PROFIT = Number(opt('min', '0'));     
const NEAR = Number(opt('near', '0'));          
const TOTAL_STAKE = Number(opt('stake', '100'));
const MIN_ODDS = Number(opt('min-odds', '1.20')); 

const SPORTY = 'SportyBet';
const MSPORT = 'MSport';
const BETBORO = 'BetBoro';
const BOLTBET = 'BoltBet';
const BETPAWA = 'BetPawa';

const clean = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9.]/g, '');
const num = (x) => {
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : null;
};

const normalizeTeam = (name) => {
  return String(name).toLowerCase()
    .replace(/\b(fc|sc|afc|cf|united|utd|city|club|women|wom|wfc|lfc)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
};

// ============================================================================
// Telegram Alert Function
// ============================================================================
async function sendTelegramAlert(arbs) {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID; 
  
  if (!token || !chatId || arbs.length === 0) return; 

  let message = `🚨 Found ${arbs.length} Arbitrage Opportunities!\n\n`;
  
  arbs.slice(0, 5).forEach((arb) => {
    message += `${arb.home} vs ${arb.away} (${arb.profitPct}%)\n`;
    message += `└ ${arb.legs[0].bookmaker}: ${arb.legs[0].outcome} @ ${arb.legs[0].odds}\n`;
    message += `└ ${arb.legs[1].bookmaker}: ${arb.legs[1].outcome} @ ${arb.legs[1].odds}\n\n`;
  });

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }) 
    });
    if (!res.ok) {
      console.error('Telegram API rejected the message:', await res.text());
    } else {
      console.log('✈️ Telegram alert sent!');
    }
  } catch (err) {
    console.error('Failed to send Telegram alert:', err.message);
  }
}

// ============================================================================
// Data Parsing Functions
// ============================================================================
function readMarket(m) {
  const found = [];
  if (!m || !Array.isArray(m.outcomes)) return found;
  if (m.status != null && Number(m.status) !== 0) return found; 

  const id = String(m.id);

  for (const o of m.outcomes) {
    if (!o || o.isActive === 0) continue;
    const odds = num(o.odds);
    if (odds === null || odds <= 1) continue;

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
      const mt = label.match(/^(over|under)(\d+)(\d?)$/); 
      if (mt) {
        const line = mt[2] + (mt[3] ? `.${mt[3]}` : '.0');
        if (line.endsWith('.5')) key = `OU:${line}:${mt[1] === 'over' ? 'O' : 'U'}`;
      }
    } else if (id === '16') { 
      const spec = m.specifiers ?? '';
      const match = spec.match(/(?:hcp=)?(-?\d+(?:\.\d+)?)/);
      const line = match ? parseFloat(match[1]) : null;
      if (line !== null) {
        if (oid === '1714' || label.includes('home')) key = `AH:${line}:H`;
        if (oid === '1715' || label.includes('away')) key = `AH:${line}:A`;
      }
    } else if (id === '139') { 
      const spec = m.specifiers ?? '';
      const match = spec.match(/(?:total=)?(-?\d+(?:\.\d+)?)/);
      const line = match ? parseFloat(match[1]) : null;
      if (line !== null && line < 15 && line.toString().endsWith('.5')) {
        if (label === 'over') key = `BOOK:${line}:O`;
        if (label === 'under') key = `BOOK:${line}:U`;
      }
    } else if (id === '166') { 
      const spec = m.specifiers ?? '';
      const match = spec.match(/(?:total=)?(-?\d+(?:\.\d+)?)/);
      const line = match ? parseFloat(match[1]) : null;
      if (line !== null && line.toString().endsWith('.5')) {
        if (label === 'over') key = `CORN:${line}:O`;
        if (label === 'under') key = `CORN:${line}:U`;
      }
    }

    if (key) found.push({ key, odds });
  }
  return found;
}

function loadBookie(file, bookie) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const events = new Map();
  const typeCounts = {};

  for (const t of raw?.data?.tournaments ?? []) {
    for (const e of t.events ?? []) {
      if (!e.eventId) continue;
      const sel = {};
      for (const m of e.markets ?? []) {
        for (const { key, odds } of readMarket(m)) {
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
    add('DC:1X', betBoroPrice(dc['0']));
    add('DC:12', betBoroPrice(dc['1']));
    add('DC:X2', betBoroPrice(dc['2']));

    const btts = f.markets?.both_teams_to_score ?? {};
    add('BTTS:Y', betBoroPrice(btts['0']));
    add('BTTS:N', betBoroPrice(btts['1']));

    for (const [line, node] of Object.entries(f.markets?.total_goals ?? {})) {
      if (!line.endsWith('.5')) continue;
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

function loadBoltBet(file) {
  if (!fs.existsSync(file)) return { events: new Map(), typeCounts: {} };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const events = new Map();
  const typeCounts = {};

  for (const e of raw.events ?? []) {
    if (!e.fixture || !e.betting || !e.betting.markets) continue;

    const sel = {};
    const add = (key, price) => {
      if (!key || price === null || price <= 1 || key in sel) return;
      sel[key] = price;
      const type = key.split(':')[0];
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    };

    for (const [marketKey, m] of Object.entries(e.betting.markets)) {
      if (m.hidden || !m.open) continue;
      const hp = m.params?.hp ? parseFloat(m.params.hp) : null;

      for (const [optionKey, option] of Object.entries(m.options ?? {})) {
        if (option.state !== 'active') continue;
        const odds = num(option.odds);
        
        if (m.type === 'winner3') {
          if (optionKey === 'home') add('1X2:H', odds);
          if (optionKey === 'draw') add('1X2:D', odds);
          if (optionKey === 'away') add('1X2:A', odds);
        } else if (m.type === '1005499') {
          if (optionKey === 'home_or_draw') add('DC:1X', odds);
          if (optionKey === 'home_or_away') add('DC:12', odds);
          if (optionKey === 'draw_or_away') add('DC:X2', odds);
        } else if (m.type === '1005500' && hp !== null) {
          if (optionKey === 'over') add(`OU:${hp}:O`, odds);
          if (optionKey === 'under') add(`OU:${hp}:U`, odds);
        } else if (m.type === '1005508') {
          if (optionKey === 'yes') add('BTTS:Y', odds);
          if (optionKey === 'no') add('BTTS:N', odds);
        } else if (m.type === '1005503' && hp !== null) {
          if (optionKey === 'home') add(`AH:${hp}:H`, odds);
          if (optionKey === 'away') add(`AH:${hp}:A`, odds);
        }
      }
    }

    const home = e.fixture.translations?.en?.[0]?.values?.home ?? '';
    const away = e.fixture.translations?.en?.[0]?.values?.away ?? '';
    const kickoff = new Date(e.fixture.metadata?.startedAt ?? e.fixture.startsAt).getTime();

    if (!home || !away) continue;

    events.set(e.fixture.uuid, {
      eventId: e.fixture.uuid,
      home,
      away,
      kickoff,
      tournament: 'BoltBet',
      notStarted: e.fixture.state === 'active',
      sel,
    });
  }
  return { events, typeCounts };
}

function loadBetPawa(file) {
  if (!fs.existsSync(file)) return { events: new Map(), typeCounts: {} };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const events = new Map();
  const typeCounts = {};

  for (const e of raw.events ?? []) {
    if (!e.eventId || !e.home || !e.away || !e.odds) continue;

    const sel = {};
    const add = (key, price) => {
      if (!key || price === null || price <= 1 || key in sel) return;
      sel[key] = price;
      const type = key.split(':')[0];
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    };

    const o = e.odds;
    add('1X2:H', o.home);
    add('1X2:D', o.draw);
    add('1X2:A', o.away);

    add('DC:1X', o.dc1x);
    add('DC:12', o.dc12);
    add('DC:X2', o.dcx2);

    add('BTTS:Y', o.bttsYes);
    add('BTTS:N', o.bttsNo);

    for (const [label, price] of Object.entries(o)) {
      const mt = label.match(/^(Over|Under)\s+(\d+(?:\.\d+)?)$/i);
      if (mt) {
        const line = mt[2];
        if (line.endsWith('.5')) {
          add(`OU:${line}:${mt[1].toLowerCase() === 'over' ? 'O' : 'U'}`, price);
        }
      }
    }

    if (Object.keys(sel).length === 0) continue;

    // BetPawa uses a dynamic kickoff time. We set it to now + 1 hour to ensure 
    // it's processed by the scanner and matches team names correctly.
    events.set(e.eventId, {
      eventId: e.eventId,
      home: e.home,
      away: e.away,
      kickoff: Date.now() + 3600000, 
      tournament: 'BetPawa',
      notStarted: true,
      sel,
    });
  }
  return { events, typeCounts };
}

const RESULT = ['H', 'D', 'A'];

const FIXED_PAIRS = [
  { a: '1X2:H', b: 'DC:X2', scen: RESULT, market: 'Home Win vs Draw/Away (X2)' },
  { a: '1X2:A', b: 'DC:1X', scen: RESULT, market: 'Away Win vs Home/Draw (1X)' },
  { a: '1X2:D', b: 'DC:12', scen: RESULT, market: 'Draw vs Home/Away (12)' },
  { a: 'DNB:H', b: 'DC:X2', scen: RESULT, market: 'DNB Home vs Draw/Away (X2)' },
  { a: 'DNB:A', b: 'DC:1X', scen: RESULT, market: 'DNB Away vs Home/Draw (1X)' },
  { a: 'DNB:H', b: 'DNB:A', scen: RESULT, profitScen: ['H', 'A'], market: 'Draw No Bet: Home vs Away', note: 'Draw = both stakes refunded' },
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
  const parts = key.split(':');
  const type = parts[0];
  
  if (type === 'OU') return `${parts[2] === 'O' ? 'Over' : 'Under'} ${parts[1]} Goals`;
  if (type === 'AH') return `${parts[2] === 'H' ? 'Home' : 'Away'} (${parts[1]})`;
  if (type === 'BOOK') return `${parts[2] === 'O' ? 'Over' : 'Under'} ${parts[1]} Bookings`;
  if (type === 'CORN') return `${parts[2] === 'O' ? 'Over' : 'Under'} ${parts[1]} Corners`;
  return key;
};

function payout(key, odds, scen) {
  const parts = key.split(':');
  const type = parts[0];
  const sel = parts[parts.length - 1];
  
  switch (type) {
    case '1X2': return sel === scen ? odds : 0;
    case 'DC': return sel.includes({ H: '1', D: 'X', A: '2' }[scen]) ? odds : 0;
    case 'DNB': return scen === 'D' ? 1 : (sel === scen ? odds : 0);
    case 'BTTS': return sel === scen ? odds : 0;
    case 'OU': case 'BOOK': case 'CORN':
      return sel === scen ? odds : 0;
    case 'AH': 
      return sel === scen ? odds : 0; 
    default: return 0;
  }
}

function evaluate(pair, oa, ob) {
  const ia = 1 / oa;
  const ib = 1 / ob;
  const shareA = ia / (ia + ib); 
  const shareB = 1 - shareA;

  const returns = {};
  for (const s of pair.scen) {
    returns[s] = shareA * payout(pair.a, oa, s) + shareB * payout(pair.b, ob, s);
  }
  const basis = pair.profitScen ?? pair.scen;
  const profitPct = (Math.min(...basis.map((s) => returns[s])) - 1) * 100;
  return { profitPct, shareA, shareB };
}

// ============================================================================
// Arb history: open / latest / final pre-kickoff prices
// ============================================================================

const historyKey = (arb) => `${arb.eventId ?? `${arb.home}|${arb.away}`}|${arb.market}`;

function loadHistory(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = Array.isArray(parsed) ? parsed : parsed?.history;
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/**
 * Folds this run's arbs into the accumulated history.
 *
 * Per leg:
 *   openOdds   first price we ever saw
 *   lastOdds   price from the latest run (always pre-kickoff, because the feeds
 *              only expose not-started events)
 *   finalOdds  lastOdds frozen the first time we see the match has kicked off
 */
function mergeHistory(previous, arbs, nowMs) {
  const byKey = new Map(previous.map((row) => [row.key ?? historyKey(row), row]));

  for (const arb of arbs) {
    const key = historyKey(arb);
    const prior = byKey.get(key);
    const priorLegs = new Map(
      (prior?.legs ?? []).map((leg) => [`${leg.bookmaker}|${leg.outcome}`, leg]),
    );
    const kickedOff = nowMs >= arb.kickoff;

    const legs = arb.legs.map((leg) => {
      const old = priorLegs.get(`${leg.bookmaker}|${leg.outcome}`);
      return {
        bookmaker: leg.bookmaker,
        outcome: leg.outcome,
        stake: leg.stake ?? null,
        openOdds: old?.openOdds ?? leg.odds,
        lastOdds: leg.odds,
        finalOdds: old?.finalOdds ?? (kickedOff ? (old?.lastOdds ?? leg.odds) : null),
      };
    });

    byKey.set(key, {
      key,
      eventId: arb.eventId ?? null,
      home: arb.home,
      away: arb.away,
      tournament: arb.tournament ?? null,
      kickoff: arb.kickoff,
      market: arb.market,
      note: arb.note ?? null,
      firstSeenAt: prior?.firstSeenAt ?? new Date(nowMs).toISOString(),
      lastSeenAt: new Date(nowMs).toISOString(),
      openProfitPct: prior?.openProfitPct ?? arb.profitPct,
      peakProfitPct: Math.max(prior?.peakProfitPct ?? arb.profitPct, arb.profitPct),
      profitPct: arb.profitPct,
      finalProfitPct: prior?.finalProfitPct ?? null,
      legs,
    });
  }

  // Freeze the close for anything that has kicked off, including arbs that have
  // already dropped out of the feed.
  const cutoff = historyCutoff(nowMs);
  const rows = [];

  for (const row of byKey.values()) {
    if (!(row.kickoff >= cutoff)) continue;

    if (nowMs >= row.kickoff) {
      for (const leg of row.legs) {
        if (leg.finalOdds == null) leg.finalOdds = leg.lastOdds;
      }
      if (row.finalProfitPct == null) row.finalProfitPct = row.profitPct;
    }

    rows.push(row);
  }

  rows.sort((a, b) => b.kickoff - a.kickoff);
  return rows.slice(0, HISTORY_LIMIT);
}

async function main() {
  const sporty = loadBookie(SPORTY_FILE, SPORTY);
  const msport = loadBookie(MSPORT_FILE, MSPORT);
  const betboro = loadBetBoro(BETBORO_FILE);
  const boltbet = loadBoltBet(BOLTBET_FILE);
  const betpawa = loadBetPawa(BETPAWA_FILE);

  const sources = [
    { name: SPORTY, book: sporty },
    { name: MSPORT, book: msport },
    { name: BETBORO, book: betboro },
    { name: BOLTBET, book: boltbet },
    { name: BETPAWA, book: betpawa },
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

  const fixturesBySrId = new Map();
  const fixturesByTeam = new Map();

  for (const { name, book } of sources) {
    for (const ev of book.events.values()) {
      if (!ev.notStarted) continue;

      const srKey = ev.eventId && ev.eventId.startsWith('sr:match:') ? ev.eventId : null;
      const teamKey = `${normalizeTeam(ev.home)}|${normalizeTeam(ev.away)}|${Math.floor(ev.kickoff / 60000)}`;

      let fixture = null;

      if (srKey && fixturesBySrId.has(srKey)) {
        fixture = fixturesBySrId.get(srKey);
      } else if (fixturesByTeam.has(teamKey)) {
        fixture = fixturesByTeam.get(teamKey);
      }

      if (!fixture) {
        fixture = { event: ev, books: {} };
        if (srKey) fixturesBySrId.set(srKey, fixture);
        fixturesByTeam.set(teamKey, fixture);
      }

      fixture.books[name] = ev.sel;
    }
  }

  const fixtures = new Map();
  for (const f of fixturesBySrId.values()) fixtures.set(f.event.eventId, f);
  for (const f of fixturesByTeam.values()) fixtures.set(f.event.eventId, f);

  const arbs = [];
  const evals = [];
  let matched = 0;
  let pairsChecked = 0;

  for (const { event, books } of fixtures.values()) {
    const names = Object.keys(books);
    if (names.length < 2) continue; 
    matched++;

    const ouLines = new Set();
    const ahLines = new Set();
    const bookLines = new Set();
    const cornLines = new Set();

    for (const name of names) {
      for (const k of Object.keys(books[name])) {
        if (k.startsWith('OU:')) ouLines.add(k.split(':')[1]);
        if (k.startsWith('AH:')) ahLines.add(k.split(':')[1]);
        if (k.startsWith('BOOK:')) bookLines.add(k.split(':')[1]);
        if (k.startsWith('CORN:')) cornLines.add(k.split(':')[1]);
      }
    }

    const pairs = [...FIXED_PAIRS];
    
    for (const line of ouLines) pairs.push({ a: `OU:${line}:O`, b: `OU:${line}:U`, scen: ['O', 'U'], market: `Over/Under ${line} Goals` });
    for (const line of bookLines) pairs.push({ a: `BOOK:${line}:O`, b: `BOOK:${line}:U`, scen: ['O', 'U'], market: `Over/Under ${line} Bookings`, needsRuleReview: true });
    for (const line of cornLines) pairs.push({ a: `CORN:${line}:O`, b: `CORN:${line}:U`, scen: ['O', 'U'], market: `Over/Under ${line} Corners`, needsRuleReview: true });
    
    for (const line of ahLines) {
      const oppositeLine = line.startsWith('-') ? line.substring(1) : `-${line}`;
      pairs.push({ 
        a: `AH:${line}:H`, 
        b: `AH:${oppositeLine}:A`, 
        scen: ['H', 'A'], 
        market: `Asian Handicap ${line}` 
      });
    }

    for (const pair of pairs) {
      for (const bookA of names) {
        for (const bookB of names) {
          if (bookA === bookB) continue;
          const oa = books[bookA][pair.a];
          const ob = books[bookB][pair.b];
          if (!oa || !ob) continue;
          if (oa < MIN_ODDS || ob < MIN_ODDS) continue; 

          pairsChecked++;

          const { profitPct, shareA, shareB } = evaluate(pair, oa, ob);
          
          if (profitPct > MIN_PROFIT || NEAR > 0) {
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
            if (pair.needsRuleReview) {
              record.needsRuleReview = true;
              record.warning = "Verify settlement data provider (e.g., Opta vs Sportradar) before betting.";
            }

            evals.push(record);
            if (profitPct > MIN_PROFIT) arbs.push(record);
          }
        }
      }
    }
  }

  arbs.sort((x, y) => y.profitPct - x.profitPct);
  evals.sort((x, y) => y.profitPct - x.profitPct);

  await sendTelegramAlert(arbs);

  console.log(`\nFixtures matched:            ${matched}`);
  console.log(`Cross-bookie pairs checked:  ${pairsChecked}`);
  console.log(`Arbs found:                  ${arbs.length}\n`);

  const printArb = (a) => {
    const reviewFlag = a.needsRuleReview ? ' ⚠️ [VERIFY RULES]' : '';
    console.log(`  ${a.home} vs ${a.away}  →  ${a.profitPct}%  [${a.market}]${reviewFlag}  (${a.tournament})`);
    for (const l of a.legs) {
      console.log(`     ${l.bookmaker}: ${l.outcome} @ ${l.odds.toFixed(2)}  (stake ${l.stake})`);
    }
    if (a.note) console.log(`     note: ${a.note}`);
    if (a.warning) console.log(`     warn: ${a.warning}`);
  };

  if (arbs.length) {
    console.log('💰 Top opportunities:');
    arbs.slice(0, 10).forEach(printArb);
  } else if (BOOST === 1) {
    console.log('No arbs right now with real odds.');
  }

  if (NEAR > 0) {
    console.log(`\nClosest ${NEAR} near-misses:`);
    evals
      .filter((r) => r.profitPct <= MIN_PROFIT)
      .slice(0, NEAR)
      .forEach(printArb);
  }

  const nowMs = Date.now();
  const history = mergeHistory(loadHistory(HISTORY_FILE), arbs, nowMs);

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
    history,
  }, null, 2));

  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify({ history }, null, 2));

  const started = history.filter((row) => nowMs >= row.kickoff).length;
  console.log(`\nWrote ${OUT_FILE}`);
  console.log(`Tracked arbs: ${history.length} (${started} started or finished, kept from ${new Date(historyCutoff(nowMs)).toISOString()})`);
  console.log(`Wrote ${HISTORY_FILE}`);
}

main().catch(console.error);