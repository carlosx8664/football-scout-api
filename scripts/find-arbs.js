// scripts/find-arbs.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  BETBORO,
  BETPAWA,
  BOLTBET,
  MSPORT,
  SOCCABET,
  SPORTY,
  buildUrl,
} from '../shared/deeplinks.js';
import { normalizeTeam } from '../shared/teams.js';

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
const SOCCABET_FILE = path.join(DATA_DIR, `soccabet${FILE_SUFFIX}.json`);
const OUT_FILE = path.resolve(__dirname, '..', 'public', opt('out', `arbs${FILE_SUFFIX}.json`));

const HISTORY_FILE = path.resolve(DATA_DIR, opt('history', 'arbs-history.json'));
const HISTORY_DAYS = Number(opt('history-days', '0'));
const HISTORY_LIMIT = Number(opt('history-limit', '500'));

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

const clean = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9.]/g, '');
const num = (x) => {
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : null;
};

// ============================================================================
// Telegram Alert
// ============================================================================
const ALERT_DEDUP_MS = 15 * 60_000;
const ALERT_PROFIT_DELTA = 0.5;

const GRADE_EXECUTE = '🚨 EXECUTE NOW (RECOMMENDED)';
const GRADE_PALPABLE_ERROR = '🔴 AVOID (PALPABLE ERROR)';
const GRADE_LOW_PROFIT = '🔴 AVOID (LOW PROFIT)';
const GRADE_CAUTION = '⚠️ CAUTION';

const WOMEN_LEAGUE_RE = /\b(wfc|women'?s?|ladies)\b/i;

const isWomenLeague = (league) => WOMEN_LEAGUE_RE.test(String(league ?? ''));

/** Reserve/"B" sides trade in thin markets, so treat them as low-limit. */
const isBTeam = (team) => /\bB\s*$/.test(String(team ?? '').trim());

function isObscureMarket(market) {
  const text = String(market ?? '').toLowerCase();
  const line = extractLine(market);
  if (line == null) return false;
  if (/booking|card/.test(text) && line >= 5.5) return true;
  if (/corner/.test(text) && line >= 10.5) return true;
  return false;
}

/** Grades an arb for account longevity and explains anything that isn't a clean execute. */
function gradeArb(arb) {
  const profit = arb.profitPct;
  const women = isWomenLeague(arb.tournament);
  const bTeam = isBTeam(arb.home) || isBTeam(arb.away);
  const obscure = isObscureMarket(arb.market);

  if (profit > 7.0) {
    return {
      grade: GRADE_PALPABLE_ERROR,
      hint: 'Suspected void. High risk of voided bet. Do not execute.',
    };
  }
  if (profit < 1.2) {
    return { grade: GRADE_LOW_PROFIT, hint: 'Too low profit. Not worth the account risk.' };
  }
  if (profit >= 2.0 && profit <= 6.0 && !women && !bTeam && !obscure) {
    return { grade: GRADE_EXECUTE, hint: null };
  }

  const reasons = [];
  if (profit < 2.0) reasons.push(`Thin profit (${profit.toFixed(2)}%)`);
  if (profit > 6.0) reasons.push(`Unusually high profit (${profit.toFixed(2)}%), often a stale price`);
  if (women) reasons.push("Women's league - low limits");
  else if (bTeam) reasons.push('B team involved - low limits');
  if (obscure) reasons.push('Obscure market - thin limits, easy to void');
  return { grade: GRADE_CAUTION, hint: reasons.join('. ') || null };
}

/** Higher odds = sharp side (bet second); lower odds = hedge (bet first). */
function executionOrder(arb) {
  const legs = arb.legs ?? [];
  if (legs.length < 2) return { hedge: legs[0], sharp: legs[0] };
  const hedge = legs.reduce((low, leg) => (leg.odds < low.odds ? leg : low));
  const sharp = legs.reduce((high, leg) => (leg.odds > high.odds ? leg : high));
  return { hedge, sharp };
}

function formatAlert(arb) {
  const { hedge, sharp } = executionOrder(arb);
  const { grade, hint } = gradeArb(arb);
  const lines = [
    grade,
    `🚨 Found Arb: ${arb.home} vs ${arb.away} (${arb.profitPct.toFixed(2)}%)`,
    `League: ${arb.tournament ?? 'Unknown'}`,
    '',
    `🟢 1st BET (Hedge): ${hedge.bookmaker} - ${hedge.outcome} @ ${hedge.odds.toFixed(2)}`,
    `🟣 2nd BET (Sharp): ${sharp.bookmaker} - ${sharp.outcome} @ ${sharp.odds.toFixed(2)}`,
  ];
  if (grade !== GRADE_EXECUTE && hint) lines.push('', hint);
  return lines.join('\n');
}

/** True unless this event+market was already alerted recently with effectively the same profit. */
function shouldAlert(arb, previousByKey, nowMs) {
  const prior = previousByKey.get(historyKey(arb));
  if (!prior?.alertedAt) return true;

  const lastAt = Date.parse(prior.alertedAt);
  if (!Number.isFinite(lastAt) || nowMs - lastAt >= ALERT_DEDUP_MS) return true;

  const lastProfit = Number(prior.alertedProfitPct);
  if (!Number.isFinite(lastProfit)) return true;

  return Math.abs(arb.profitPct - lastProfit) >= ALERT_PROFIT_DELTA;
}

async function sendTelegramAlert(arbs, previous = [], nowMs = Date.now()) {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId || arbs.length === 0) return;

  const previousByKey = new Map(previous.map((row) => [row.key ?? historyKey(row), row]));
  const pending = arbs.filter((arb) => shouldAlert(arb, previousByKey, nowMs));
  if (pending.length === 0) {
    console.log('No new alerts: every arb was already sent in the last 15 minutes.');
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  for (const arb of pending) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: formatAlert(arb),
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        console.error('Telegram API rejected the message:', await res.text());
        continue;
      }
      // Remembered in the history row so the next run can dedupe.
      arb.alertedAt = new Date(nowMs).toISOString();
      arb.alertedProfitPct = arb.profitPct;
      console.log(`✈️ Telegram alert sent: ${arb.home} vs ${arb.away} (${arb.profitPct}%)`);
    } catch (err) {
      console.error('Failed to send Telegram alert:', err.message);
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================
/** Extracts the numeric line (e.g. 2.5, -1.5) from a specifier string. */
function extractLine(spec) {
  if (!spec || typeof spec !== 'string') return null;
  // Handles "total=2.5", "hcp=-1.5", "total=12.5"
  const m = spec.match(/(?:total=|hcp=)?(-?\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

/** Determines if a description string is Over/Under/Home/Away. */
function pickSide(desc) {
  const c = clean(desc);
  if (c.startsWith('over')) return 'O';
  if (c.startsWith('under')) return 'U';
  if (c.startsWith('home')) return 'H';
  if (c.startsWith('away')) return 'A';
  if (c === 'yes') return 'Y';
  if (c === 'no') return 'N';
  if (c === 'draw') return 'D';
  if (c === '1') return 'H';
  if (c === '2') return 'A';
  if (c === 'x') return 'D';
  return null;
}

// ============================================================================
// SportyBet Parser
// ============================================================================
function readSportyMarket(m) {
  const found = [];
  if (!m || !Array.isArray(m.outcomes)) return found;
  if (m.status != null && Number(m.status) !== 0) return found; 

  const id = String(m.id);
  // SportyBet uses `specifier` (singular). Fall back to `specifiers` just in case.
  const spec = m.specifier ?? m.specifiers ?? '';

  for (const o of m.outcomes) {
    if (!o || o.isActive === 0) continue;
    const odds = num(o.odds);
    if (odds === null || odds <= 1) continue;

    const desc = o.desc ?? o.description ?? '';
    const side = pickSide(desc);
    const oid = String(o.id);
    let key;

    // 1X2
    if (id === '1') {
      if (side === 'H') key = '1X2:H';
      else if (side === 'D') key = '1X2:D';
      else if (side === 'A') key = '1X2:A';
    }
    // Double Chance
    else if (id === '10') {
      const c = clean(desc);
      if (c === '1x' || c === 'homeordraw') key = 'DC:1X';
      else if (c === '12' || c === 'homeoraway') key = 'DC:12';
      else if (c === 'x2' || c === 'draworaway') key = 'DC:X2';
    }
    // DNB
    else if (id === '11') {
      if (side === 'H') key = 'DNB:H';
      else if (side === 'A') key = 'DNB:A';
    }
    // BTTS
    else if (id === '29') {
      if (side === 'Y') key = 'BTTS:Y';
      else if (side === 'N') key = 'BTTS:N';
    }
    // O/U Goals
    else if (id === '18') {
      const line = extractLine(spec);
      if (line !== null && line.toString().endsWith('.5') && side) {
        key = `OU:${line}:${side}`;
      }
    }
    // Asian Handicap
    else if (id === '16') {
      const line = extractLine(spec);
      if (line !== null && side) {
        key = `AH:${line}:${side}`;
      }
    }
    // Total Bookings
    else if (id === '139') {
      const line = extractLine(spec);
      if (line !== null && line.toString().endsWith('.5') && side) {
        key = `BOOK:${line}:${side}`;
      }
    }
    // Total Corners
    else if (id === '166') {
      const line = extractLine(spec);
      if (line !== null && line.toString().endsWith('.5') && side) {
        key = `CORN:${line}:${side}`;
      }
    }
    // Total Tackles
    else if (id === '900319') {
      const line = extractLine(spec);
      if (line !== null && line.toString().endsWith('.5') && side) {
        key = `TACKLE:${line}:${side}`;
      }
    }
    // Total Throw-Ins
    else if (id === '900322') {
      const line = extractLine(spec);
      if (line !== null && line.toString().endsWith('.5') && side) {
        key = `THROW:${line}:${side}`;
      }
    }
    // Total Shots
    else if (id === '900394') {
      const line = extractLine(spec);
      if (line !== null && side) {
        key = `SHOTS:${line}:${side}`;
      }
    }
    // Total Shots on Target
    else if (id === '900393') {
      const line = extractLine(spec);
      if (line !== null && side) {
        key = `SOT:${line}:${side}`;
      }
    }
    // Home Team Shots
    else if (id === '900552') {
      const line = extractLine(spec);
      if (line !== null && side) key = `TEAM_SHOTS:H:${line}:${side}`;
    }
    // Away Team Shots
    else if (id === '900553') {
      const line = extractLine(spec);
      if (line !== null && side) key = `TEAM_SHOTS:A:${line}:${side}`;
    }
    // Home Team Shots on Target
    else if (id === '900546') {
      const line = extractLine(spec);
      if (line !== null && side) key = `TEAM_SOT:H:${line}:${side}`;
    }
    // Away Team Shots on Target
    else if (id === '900547') {
      const line = extractLine(spec);
      if (line !== null && side) key = `TEAM_SOT:A:${line}:${side}`;
    }
    // 1st Half Shots
    else if (id === '900556') {
      const line = extractLine(spec);
      if (line !== null && side) key = `H1_SHOTS:${line}:${side}`;
    }
    // 1st Half Shots on Target
    else if (id === '900550') {
      const line = extractLine(spec);
      if (line !== null && side) key = `H1_SOT:${line}:${side}`;
    }
    // Home Team Total Bookings
    else if (id === '900304') {
      const line = extractLine(spec);
      if (line !== null && side) key = `TEAM_BOOK:H:${line}:${side}`;
    }
    // Away Team Total Bookings
    else if (id === '900305') {
      const line = extractLine(spec);
      if (line !== null && side) key = `TEAM_BOOK:A:${line}:${side}`;
    }
    // 1st Half Home Team Bookings
    else if (id === '900306') {
      const line = extractLine(spec);
      if (line !== null && side) key = `H1_TEAM_BOOK:H:${line}:${side}`;
    }
    // 1st Half Away Team Bookings
    else if (id === '900307') {
      const line = extractLine(spec);
      if (line !== null && side) key = `H1_TEAM_BOOK:A:${line}:${side}`;
    }

    // SportyBet's own ids travel with the selection so the UI can book it later.
    if (key) found.push({ key, odds, marketId: id, outcomeId: oid, specifier: spec });
  }
  return found;
}

// ============================================================================
// MSport Parser
// ============================================================================
function readMSportMarket(m) {
  const found = [];
  if (!m || !Array.isArray(m.outcomes)) return found;
  if (m.status != null && Number(m.status) !== 0) return found;

  const id = String(m.id);
  const spec = m.specifier ?? m.specifiers ?? '';

  for (const o of m.outcomes) {
    if (!o || o.isActive === 0) continue;
    const odds = num(o.odds);
    if (odds === null || odds <= 1) continue;

    const desc = o.description ?? o.desc ?? '';
    const side = pickSide(desc);
    const oid = String(o.id);
    let key;

    if (id === '1') {
      if (side === 'H') key = '1X2:H';
      else if (side === 'D') key = '1X2:D';
      else if (side === 'A') key = '1X2:A';
    }
    else if (id === '10') {
      const c = clean(desc);
      if (c === '1x' || c === 'homeordraw') key = 'DC:1X';
      else if (c === '12' || c === 'homeoraway') key = 'DC:12';
      else if (c === 'x2' || c === 'draworaway') key = 'DC:X2';
    }
    else if (id === '11') {
      if (side === 'H') key = 'DNB:H';
      else if (side === 'A') key = 'DNB:A';
    }
    else if (id === '29') {
      if (side === 'Y') key = 'BTTS:Y';
      else if (side === 'N') key = 'BTTS:N';
    }
    else if (id === '18') {
      const line = extractLine(spec);
      if (line !== null && line.toString().endsWith('.5') && side) key = `OU:${line}:${side}`;
    }
    else if (id === '16') {
      const line = extractLine(spec);
      if (line !== null && side) key = `AH:${line}:${side}`;
    }
    else if (id === '139') {
      const line = extractLine(spec);
      if (line !== null && line.toString().endsWith('.5') && side) key = `BOOK:${line}:${side}`;
    }
    else if (id === '166') {
      const line = extractLine(spec);
      if (line !== null && line.toString().endsWith('.5') && side) key = `CORN:${line}:${side}`;
    }
    // MSport Team Total Goals (19,20)
    else if (id === '19' || id === '20') {
      const line = extractLine(spec);
      const team = id === '19' ? 'H' : 'A';
      if (line !== null && line.toString().endsWith('.5') && side) {
        key = `TEAM_OU:${team}:${line}:${side}`;
      }
    }
    // MSport 1st Half Team Total Goals (69,70)
    else if (id === '69' || id === '70') {
      const line = extractLine(spec);
      const team = id === '69' ? 'H' : 'A';
      if (line !== null && line.toString().endsWith('.5') && side) {
        key = `H1_TEAM_OU:${team}:${line}:${side}`;
      }
    }
    // MSport 2nd Half Team Total Goals (91,92)
    else if (id === '91' || id === '92') {
      const line = extractLine(spec);
      const team = id === '91' ? 'H' : 'A';
      if (line !== null && line.toString().endsWith('.5') && side) {
        key = `H2_TEAM_OU:${team}:${line}:${side}`;
      }
    }

    if (key) found.push({ key, odds });
  }
  return found;
}

// ============================================================================
// Data Loaders
// ============================================================================
function loadBookie(file, bookie) {
  if (!fs.existsSync(file)) return { events: new Map(), typeCounts: {} };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const events = new Map();
  const typeCounts = {};

  const parseFn = bookie === SPORTY ? readSportyMarket : readMSportMarket;

  for (const t of raw?.data?.tournaments ?? []) {
    for (const e of t.events ?? []) {
      if (!e.eventId) continue;
      const sel = {};
      const selIds = {};
      for (const m of e.markets ?? []) {
        for (const { key, odds, marketId, outcomeId, specifier } of parseFn(m)) {
          if (key in sel) continue;
          sel[key] = bookie === MSPORT ? odds * BOOST : odds;
          // Only the SportyBet parser returns ids; they drive the booking-code endpoint.
          if (marketId) selIds[key] = { marketId, outcomeId, specifier: specifier ?? '' };
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
        selIds,
        raw: e, // Store raw data for deep linking
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
  if (!fs.existsSync(file)) return { events: new Map(), typeCounts: {} };
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

    // BetBoro's `total_corners` (if present in overview_markets)
    for (const [line, node] of Object.entries(f.markets?.total_corners ?? {})) {
      if (!line.endsWith('.5')) continue;
      add(`CORN:${line}:O`, betBoroPrice(node?.['0']));
      add(`CORN:${line}:U`, betBoroPrice(node?.['1']));
    }

    // BetBoro's `total_cards` (if present in overview_markets)
    for (const [line, node] of Object.entries(f.markets?.total_cards ?? {})) {
      if (!line.endsWith('.5')) continue;
      add(`BOOK:${line}:O`, betBoroPrice(node?.['0']));
      add(`BOOK:${line}:U`, betBoroPrice(node?.['1']));
    }

    // BetBoro's `total_tackles`
    for (const [line, node] of Object.entries(f.markets?.total_tackles ?? {})) {
      if (!line.endsWith('.5')) continue;
      add(`TACKLE:${line}:O`, betBoroPrice(node?.['0']));
      add(`TACKLE:${line}:U`, betBoroPrice(node?.['1']));
    }

    // BetBoro's `total_throw_ins`
    for (const [line, node] of Object.entries(f.markets?.total_throw_ins ?? {})) {
      if (!line.endsWith('.5')) continue;
      add(`THROW:${line}:O`, betBoroPrice(node?.['0']));
      add(`THROW:${line}:U`, betBoroPrice(node?.['1']));
    }

    // BetBoro's `total_shots` (if present in overview_markets)
    for (const [line, node] of Object.entries(f.markets?.total_shots ?? {})) {
      if (!line.endsWith('.5')) continue;
      add(`SHOTS:${line}:O`, betBoroPrice(node?.['0']));
      add(`SHOTS:${line}:U`, betBoroPrice(node?.['1']));
    }

    // BetBoro's `total_shots_on_target` (if present in overview_markets)
    for (const [line, node] of Object.entries(f.markets?.total_shots_on_target ?? {})) {
      if (!line.endsWith('.5')) continue;
      add(`SOT:${line}:O`, betBoroPrice(node?.['0']));
      add(`SOT:${line}:U`, betBoroPrice(node?.['1']));
    }

    events.set(f.eventId, {
      eventId: f.eventId,
      home: f.home,
      away: f.away,
      kickoff: f.kickoff,
      tournament: `${f.region ?? ''} · ${f.competition ?? ''}`.trim(),
      notStarted: Number(f.kickoff) > Date.now(),
      sel,
      raw: {
        betBoroId: f.betBoroId,
        regionId: f.regionId ?? f.region_id,
        competitionId: f.competitionId ?? f.competition_id,
      },
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
        } else if (m.type === '1005501' && hp !== null) {
          if (optionKey === 'over') add(`TEAM_OU:H:${hp}:O`, odds);
          if (optionKey === 'under') add(`TEAM_OU:H:${hp}:U`, odds);
        } else if (m.type === '1005502' && hp !== null) {
          if (optionKey === 'over') add(`TEAM_OU:A:${hp}:O`, odds);
          if (optionKey === 'under') add(`TEAM_OU:A:${hp}:U`, odds);
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
      raw: { uuid: e.fixture.uuid, boltbetSlug: e.fixture.slug },
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

    events.set(e.eventId, {
      eventId: e.eventId,
      home: e.home,
      away: e.away,
      // Real kickoff written by fetch-betpawa.js; the old Date.now() guess only remains as a
      // fallback for snapshots captured before that fix.
      kickoff: Number(e.kickoff) > 0 ? Number(e.kickoff) : Date.now() + 3600000,
      tournament: 'BetPawa',
      notStarted: true,
      sel,
      raw: { eventId: e.eventId },
    });
  }
  return { events, typeCounts };
}

/**
 * Soccabet — pre-match snapshot from `scripts/fetch-soccabet.js` (isd.js + socket).
 *
 * Already in canonical `sel` keys (`1X2:H`, `BTTS:Y`, `OU:2.5:O`, …), so no re-mapping here.
 * isd.js publishes `0` and `101` sentinel prices for suspended/hidden markets: anything at or
 * below 1, or at 101+, is dropped so it can never produce a phantom arb.
 */
function loadSoccabet(file) {
  if (!fs.existsSync(file)) return { events: new Map(), typeCounts: {} };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const events = new Map();
  const typeCounts = {};

  for (const e of raw.events ?? []) {
    if (!e.eventId || !e.home || !e.away || !e.sel) continue;
    if (e.isLive) continue;

    const sel = {};
    for (const [key, value] of Object.entries(e.sel)) {
      const price = num(value);
      if (price === null || price <= 1 || price >= 101) continue;
      sel[key] = price;
      const type = key.split(':')[0];
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    }

    if (Object.keys(sel).length === 0) continue;

    const kickoff = Number(e.kickoff);
    if (!Number.isFinite(kickoff)) continue;

    events.set(e.eventId, {
      eventId: e.eventId,
      home: e.home,
      away: e.away,
      kickoff,
      tournament: e.league ?? 'Soccabet',
      notStarted: true,
      sel,
      raw: { soccabetId: e.soccabetId, code: e.code, league: e.league },
    });
  }
  return { events, typeCounts };
}

// ============================================================================
// Arb Evaluation
// ============================================================================
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
  if (type === 'TACKLE') return `${parts[2] === 'O' ? 'Over' : 'Under'} ${parts[1]} Tackles`;
  if (type === 'THROW') return `${parts[2] === 'O' ? 'Over' : 'Under'} ${parts[1]} Throw-Ins`;
  if (type === 'SHOTS') return `${parts[2] === 'O' ? 'Over' : 'Under'} ${parts[1]} Shots`;
  if (type === 'SOT') return `${parts[2] === 'O' ? 'Over' : 'Under'} ${parts[1]} Shots on Target`;
  if (type === 'H1_SHOTS') return `1st Half ${parts[2] === 'O' ? 'Over' : 'Under'} ${parts[1]} Shots`;
  if (type === 'H1_SOT') return `1st Half ${parts[2] === 'O' ? 'Over' : 'Under'} ${parts[1]} Shots on Target`;

  // Team Totals
  if (type === 'TEAM_OU') return `${parts[1] === 'H' ? 'Home' : 'Away'} Team ${parts[3] === 'O' ? 'Over' : 'Under'} ${parts[2]} Goals`;
  if (type === 'H1_TEAM_OU') return `1st Half ${parts[1] === 'H' ? 'Home' : 'Away'} Team ${parts[3] === 'O' ? 'Over' : 'Under'} ${parts[2]} Goals`;
  if (type === 'H2_TEAM_OU') return `2nd Half ${parts[1] === 'H' ? 'Home' : 'Away'} Team ${parts[3] === 'O' ? 'Over' : 'Under'} ${parts[2]} Goals`;
  if (type === 'TEAM_SHOTS') return `${parts[1] === 'H' ? 'Home' : 'Away'} Team ${parts[3] === 'O' ? 'Over' : 'Under'} ${parts[2]} Shots`;
  if (type === 'TEAM_SOT') return `${parts[1] === 'H' ? 'Home' : 'Away'} Team ${parts[3] === 'O' ? 'Over' : 'Under'} ${parts[2]} Shots on Target`;
  if (type === 'TEAM_BOOK') return `${parts[1] === 'H' ? 'Home' : 'Away'} Team ${parts[3] === 'O' ? 'Over' : 'Under'} ${parts[2]} Cards`;
  if (type === 'H1_TEAM_BOOK') return `1st Half ${parts[1] === 'H' ? 'Home' : 'Away'} Team ${parts[3] === 'O' ? 'Over' : 'Under'} ${parts[2]} Cards`;
  
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
    case 'OU': case 'BOOK': case 'CORN': case 'TACKLE': case 'THROW': case 'SHOTS': case 'SOT': case 'H1_SHOTS': case 'H1_SOT':
    case 'TEAM_OU': case 'H1_TEAM_OU': case 'H2_TEAM_OU': case 'TEAM_SHOTS': case 'TEAM_SOT': case 'TEAM_BOOK': case 'H1_TEAM_BOOK':
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
// Arb History
// ============================================================================
const historyKey = (arb) => `${arb.eventId ?? `${arb.home}|${arb.away}`}|${arb.market}`;

/** Prior legs are matched loosely: bookmakers retitle selections between runs. */
const legLabel = (leg) =>
  `${String(leg.bookmaker ?? '').trim().toLowerCase()}|${String(leg.outcome ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')}`;

const bookmakerLabel = (leg) => String(leg.bookmaker ?? '').trim().toLowerCase();

/** Indexes a row's legs by full label, plus by bookmaker when that's unambiguous. */
function indexLegs(legs) {
  const byLabel = new Map();
  const byBookmaker = new Map();

  for (const leg of legs ?? []) {
    byLabel.set(legLabel(leg), leg);
    const book = bookmakerLabel(leg);
    byBookmaker.set(book, byBookmaker.has(book) ? null : leg);
  }

  return { byLabel, byBookmaker };
}

const findPriorLeg = (index, leg) =>
  index.byLabel.get(legLabel(leg)) ?? index.byBookmaker.get(bookmakerLabel(leg)) ?? null;

function loadHistory(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = Array.isArray(parsed) ? parsed : parsed?.history;
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function mergeHistory(previous, arbs, nowMs) {
  const byKey = new Map(previous.map((row) => [row.key ?? historyKey(row), row]));

  for (const arb of arbs) {
    const key = historyKey(arb);
    const prior = byKey.get(key);
    const priorLegs = indexLegs(prior?.legs);
    const kickedOff = nowMs >= arb.kickoff;

    const legs = arb.legs.map((leg) => {
      const old = findPriorLeg(priorLegs, leg);
      return {
        bookmaker: leg.bookmaker,
        outcome: leg.outcome,
        stake: leg.stake ?? null,
        url: leg.url ?? null,
        // Only a pre-kickoff sighting is a real open price; capturing one after kickoff
        // would show a fake 0% move against itself.
        openOdds: old?.openOdds ?? (kickedOff ? null : leg.odds),
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
      alertedAt: arb.alertedAt ?? prior?.alertedAt ?? null,
      alertedProfitPct: arb.alertedProfitPct ?? prior?.alertedProfitPct ?? null,
      legs,
    });
  }

  const cutoff = historyCutoff(nowMs);
  const rows = [];

  for (const row of byKey.values()) {
    if (!(row.kickoff >= cutoff)) continue;

    if (nowMs >= row.kickoff) {
      for (const leg of row.legs) {
        // Freeze the last pre-kickoff price the first time the match shows as started.
        if (leg.finalOdds == null) leg.finalOdds = leg.lastOdds;
      }
      if (row.finalProfitPct == null) row.finalProfitPct = row.profitPct;
    }

    rows.push(row);
  }

  rows.sort((a, b) => b.kickoff - a.kickoff);
  return rows.slice(0, HISTORY_LIMIT);
}

// ============================================================================
// Main
// ============================================================================
async function main() {
  const sporty = loadBookie(SPORTY_FILE, SPORTY);
  const msport = loadBookie(MSPORT_FILE, MSPORT);
  const betboro = loadBetBoro(BETBORO_FILE);
  const boltbet = loadBoltBet(BOLTBET_FILE);
  const betpawa = loadBetPawa(BETPAWA_FILE);
  const soccabet = loadSoccabet(SOCCABET_FILE);

  const sources = [
    { name: SPORTY, book: sporty },
    { name: MSPORT, book: msport },
    { name: BETBORO, book: betboro },
    { name: BOLTBET, book: boltbet },
    { name: BETPAWA, book: betpawa },
    { name: SOCCABET, book: soccabet },
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
  // Same teams without the kickoff bucket, so a fixture split across a bucket boundary
  // (e.g. 19:59 on one book, 20:01 on another) still matches.
  const fixturesByName = new Map();
  /** Kickoffs further apart than this are treated as different fixtures. */
  const KICKOFF_TOLERANCE_MS = 2 * 60 * 60 * 1000;

  for (const { name, book } of sources) {
    for (const ev of book.events.values()) {
      if (!ev.notStarted) continue;

      const srKey = ev.eventId && ev.eventId.startsWith('sr:match:') ? ev.eventId : null;
      // 2-hour kickoff tolerance for team-name matching
      const timeKey = Math.floor(ev.kickoff / 7200000);
      const homeKey = normalizeTeam(ev.home);
      const awayKey = normalizeTeam(ev.away);
      const teamKey = `${homeKey}|${awayKey}|${timeKey}`;
      const nameKey = `${homeKey}|${awayKey}`;

      let fixture = null;

      // 1. sr:match ID priority
      if (srKey && fixturesBySrId.has(srKey)) {
        fixture = fixturesBySrId.get(srKey);
      }
      // 2. Exact team-name + kickoff bucket
      else if (fixturesByTeam.has(teamKey)) {
        fixture = fixturesByTeam.get(teamKey);
      }
      // 3. Team names within the kickoff tolerance (covers bucket edges and books with
      //    slightly different start times, which is how Soccabet usually lines up).
      else {
        fixture =
          (fixturesByName.get(nameKey) ?? []).find(
            (candidate) =>
              Math.abs(candidate.event.kickoff - ev.kickoff) <= KICKOFF_TOLERANCE_MS &&
              !candidate.books[name],
          ) ?? null;
      }

      if (!fixture) {
        fixture = { event: ev, books: {}, raw: {}, selIds: {} };
        if (srKey) fixturesBySrId.set(srKey, fixture);
        fixturesByTeam.set(teamKey, fixture);
        const siblings = fixturesByName.get(nameKey) ?? [];
        siblings.push(fixture);
        fixturesByName.set(nameKey, siblings);
      } else if (!fixturesByTeam.has(teamKey)) {
        // Remember the extra bucket so later books with the same kickoff resolve directly.
        fixturesByTeam.set(teamKey, fixture);
      }

      fixture.books[name] = ev.sel;
      fixture.raw[name] = ev.raw || {};
      fixture.selIds[name] = ev.selIds || {};
    }
  }

  const fixtures = new Map();
  for (const f of fixturesBySrId.values()) fixtures.set(f.event.eventId, f);
  for (const f of fixturesByTeam.values()) fixtures.set(f.event.eventId, f);

  // Per-bookie coverage over joinable fixtures only: shows whether each book actually overlaps
  // with the others (a book at 0 is present but not matched to anything).
  const coverage = {};
  let joinable = 0;
  for (const f of fixtures.values()) {
    if (Object.keys(f.books).length < 2) continue;
    joinable++;
    for (const name of Object.keys(f.books)) coverage[name] = (coverage[name] ?? 0) + 1;
  }
  console.log(`\nFixture coverage (${joinable} joinable of ${fixtures.size} fixtures)`);
  for (const { name } of sources) {
    console.log(`  ${name.padEnd(10)} ${coverage[name] ?? 0}`);
  }

  const arbs = [];
  const evals = [];
  let matched = 0;
  let pairsChecked = 0;

  for (const { event, books, raw, selIds } of fixtures.values()) {
    const names = Object.keys(books);
    if (names.length < 2) continue; 
    matched++;

    const ouLines = new Set();
    const ahLines = new Set();
    const bookLines = new Set();
    const cornLines = new Set();
    const tackleLines = new Set();
    const throwLines = new Set();
    const shotsLines = new Set();
    const sotLines = new Set();
    const h1ShotsLines = new Set();
    const h1SotLines = new Set();
    
    // Team Totals
    const teamOuLines = new Set();
    const h1TeamOuLines = new Set();
    const h2TeamOuLines = new Set();
    const teamShotsLines = new Set();
    const teamSotLines = new Set();
    const teamBookLines = new Set();
    const h1TeamBookLines = new Set();

    for (const name of names) {
      for (const k of Object.keys(books[name])) {
        if (k.startsWith('OU:')) ouLines.add(k.split(':')[1]);
        if (k.startsWith('AH:')) ahLines.add(k.split(':')[1]);
        if (k.startsWith('BOOK:')) bookLines.add(k.split(':')[1]);
        if (k.startsWith('CORN:')) cornLines.add(k.split(':')[1]);
        if (k.startsWith('TACKLE:')) tackleLines.add(k.split(':')[1]);
        if (k.startsWith('THROW:')) throwLines.add(k.split(':')[1]);
        if (k.startsWith('SHOTS:')) shotsLines.add(k.split(':')[1]);
        if (k.startsWith('SOT:')) sotLines.add(k.split(':')[1]);
        if (k.startsWith('H1_SHOTS:')) h1ShotsLines.add(k.split(':')[1]);
        if (k.startsWith('H1_SOT:')) h1SotLines.add(k.split(':')[1]);
        
        if (k.startsWith('TEAM_OU:')) teamOuLines.add(k.split(':')[2]);
        if (k.startsWith('H1_TEAM_OU:')) h1TeamOuLines.add(k.split(':')[2]);
        if (k.startsWith('H2_TEAM_OU:')) h2TeamOuLines.add(k.split(':')[2]);
        if (k.startsWith('TEAM_SHOTS:')) teamShotsLines.add(k.split(':')[2]);
        if (k.startsWith('TEAM_SOT:')) teamSotLines.add(k.split(':')[2]);
        if (k.startsWith('TEAM_BOOK:')) teamBookLines.add(k.split(':')[2]);
        if (k.startsWith('H1_TEAM_BOOK:')) h1TeamBookLines.add(k.split(':')[2]);
      }
    }

    const pairs = [...FIXED_PAIRS];
    
    for (const line of ouLines) pairs.push({ a: `OU:${line}:O`, b: `OU:${line}:U`, scen: ['O', 'U'], market: `Over/Under ${line} Goals` });
    for (const line of bookLines) pairs.push({ a: `BOOK:${line}:O`, b: `BOOK:${line}:U`, scen: ['O', 'U'], market: `Over/Under ${line} Bookings`, needsRuleReview: true });
    for (const line of cornLines) pairs.push({ a: `CORN:${line}:O`, b: `CORN:${line}:U`, scen: ['O', 'U'], market: `Over/Under ${line} Corners`, needsRuleReview: true });
    for (const line of tackleLines) pairs.push({ a: `TACKLE:${line}:O`, b: `TACKLE:${line}:U`, scen: ['O', 'U'], market: `Over/Under ${line} Tackles`, needsRuleReview: true });
    for (const line of throwLines) pairs.push({ a: `THROW:${line}:O`, b: `THROW:${line}:U`, scen: ['O', 'U'], market: `Over/Under ${line} Throw-Ins`, needsRuleReview: true });
    for (const line of shotsLines) pairs.push({ a: `SHOTS:${line}:O`, b: `SHOTS:${line}:U`, scen: ['O', 'U'], market: `Over/Under ${line} Shots` });
    for (const line of sotLines) pairs.push({ a: `SOT:${line}:O`, b: `SOT:${line}:U`, scen: ['O', 'U'], market: `Over/Under ${line} Shots on Target` });
    for (const line of h1ShotsLines) pairs.push({ a: `H1_SHOTS:${line}:O`, b: `H1_SHOTS:${line}:U`, scen: ['O', 'U'], market: `1st Half Over/Under ${line} Shots` });
    for (const line of h1SotLines) pairs.push({ a: `H1_SOT:${line}:O`, b: `H1_SOT:${line}:U`, scen: ['O', 'U'], market: `1st Half Over/Under ${line} Shots on Target` });

    for (const line of teamOuLines) {
      pairs.push({ a: `TEAM_OU:H:${line}:O`, b: `TEAM_OU:H:${line}:U`, scen: ['O', 'U'], market: `Home Team O/U ${line} Goals` });
      pairs.push({ a: `TEAM_OU:A:${line}:O`, b: `TEAM_OU:A:${line}:U`, scen: ['O', 'U'], market: `Away Team O/U ${line} Goals` });
    }
    for (const line of h1TeamOuLines) {
      pairs.push({ a: `H1_TEAM_OU:H:${line}:O`, b: `H1_TEAM_OU:H:${line}:U`, scen: ['O', 'U'], market: `1st Half Home O/U ${line} Goals` });
      pairs.push({ a: `H1_TEAM_OU:A:${line}:O`, b: `H1_TEAM_OU:A:${line}:U`, scen: ['O', 'U'], market: `1st Half Away O/U ${line} Goals` });
    }
    for (const line of h2TeamOuLines) {
      pairs.push({ a: `H2_TEAM_OU:H:${line}:O`, b: `H2_TEAM_OU:H:${line}:U`, scen: ['O', 'U'], market: `2nd Half Home O/U ${line} Goals` });
      pairs.push({ a: `H2_TEAM_OU:A:${line}:O`, b: `H2_TEAM_OU:A:${line}:U`, scen: ['O', 'U'], market: `2nd Half Away O/U ${line} Goals` });
    }
    for (const line of teamShotsLines) {
      pairs.push({ a: `TEAM_SHOTS:H:${line}:O`, b: `TEAM_SHOTS:H:${line}:U`, scen: ['O', 'U'], market: `Home Team O/U ${line} Shots` });
      pairs.push({ a: `TEAM_SHOTS:A:${line}:O`, b: `TEAM_SHOTS:A:${line}:U`, scen: ['O', 'U'], market: `Away Team O/U ${line} Shots` });
    }
    for (const line of teamSotLines) {
      pairs.push({ a: `TEAM_SOT:H:${line}:O`, b: `TEAM_SOT:H:${line}:U`, scen: ['O', 'U'], market: `Home Team O/U ${line} Shots on Target` });
      pairs.push({ a: `TEAM_SOT:A:${line}:O`, b: `TEAM_SOT:A:${line}:U`, scen: ['O', 'U'], market: `Away Team O/U ${line} Shots on Target` });
    }
    for (const line of teamBookLines) {
      pairs.push({ a: `TEAM_BOOK:H:${line}:O`, b: `TEAM_BOOK:H:${line}:U`, scen: ['O', 'U'], market: `Home Team O/U ${line} Cards`, needsRuleReview: true });
      pairs.push({ a: `TEAM_BOOK:A:${line}:O`, b: `TEAM_BOOK:A:${line}:U`, scen: ['O', 'U'], market: `Away Team O/U ${line} Cards`, needsRuleReview: true });
    }
    for (const line of h1TeamBookLines) {
      pairs.push({ a: `H1_TEAM_BOOK:H:${line}:O`, b: `H1_TEAM_BOOK:H:${line}:U`, scen: ['O', 'U'], market: `1st Half Home O/U ${line} Cards`, needsRuleReview: true });
      pairs.push({ a: `H1_TEAM_BOOK:A:${line}:O`, b: `H1_TEAM_BOOK:A:${line}:U`, scen: ['O', 'U'], market: `1st Half Away O/U ${line} Cards`, needsRuleReview: true });
    }

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
            // SportyBet ids make the leg bookable in one click; other books only get deep links.
            const bookingFor = (book, key) => {
              const ids = selIds?.[book]?.[key];
              return ids ? { sportybet: { eventId: event.eventId, ...ids } } : {};
            };

            const record = {
              eventId: event.eventId,
              home: event.home,
              away: event.away,
              tournament: event.tournament,
              kickoff: event.kickoff,
              market: pair.market,
              profitPct: Number(profitPct.toFixed(3)),
              legs: [
                { 
                  bookmaker: bookA, 
                  outcome: labelOf(pair.a), 
                  odds: Number(oa.toFixed(2)), 
                  stake: Number((TOTAL_STAKE * shareA).toFixed(2)),
                  url: buildUrl(bookA, event.eventId, event.home, event.away, { ...raw[bookA], league: event.tournament }),
                  ...bookingFor(bookA, pair.a)
                },
                { 
                  bookmaker: bookB, 
                  outcome: labelOf(pair.b), 
                  odds: Number(ob.toFixed(2)), 
                  stake: Number((TOTAL_STAKE * shareB).toFixed(2)),
                  url: buildUrl(bookB, event.eventId, event.home, event.away, { ...raw[bookB], league: event.tournament }),
                  ...bookingFor(bookB, pair.b)
                },
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

  const nowMs = Date.now();
  const previousHistory = loadHistory(HISTORY_FILE);
  await sendTelegramAlert(arbs, previousHistory, nowMs);

  console.log(`\nFixtures matched:            ${matched}`);
  console.log(`Cross-bookie pairs checked:  ${pairsChecked}`);
  console.log(`Arbs found:                  ${arbs.length}\n`);

  const printArb = (a) => {
    const reviewFlag = a.needsRuleReview ? ' ⚠️ [VERIFY RULES]' : '';
    console.log(`  ${a.home} vs ${a.away}  →  ${a.profitPct}%  [${a.market}]${reviewFlag}  (${a.tournament})`);
    for (const l of a.legs) {
      console.log(`     ${l.bookmaker}: ${l.outcome} @ ${l.odds.toFixed(2)}  (stake ${l.stake})`);
      if (l.url) console.log(`       ↳ ${l.url}`);
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

  const history = mergeHistory(previousHistory, arbs, nowMs);

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