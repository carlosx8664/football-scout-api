import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('data');
const SPORTY_FILE = path.join(DATA_DIR, 'sportybet.json');
const MSPORT_FILE = path.join(DATA_DIR, 'msport.json');

// ⚠️ FAKE ODDS BOOST (For testing the math logic)
const ODDS_BOOST_MULTIPLIER = 1.15; // 15% boost

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------
const ABBREV = {
  utd: 'united', nottm: 'nottingham', ath: 'athletic', wand: 'wanderers',
  wnd: 'wanderers', intl: 'international', st: 'saint', std: 'standard',
  mun: 'munich', mgladbach: 'monchengladbach', gladbach: 'monchengladbach',
  brg: 'brugge', spb: 'sporting', sp: 'sporting',
};

const DROP_TOKENS = new Set([
  'fc', 'cf', 'sc', 'afc', 'ac', 'as', 'ss', 'ssc', 'fk', 'pfk',
  'sk', 'sv', 'vfb', 'vfl', 'tsv', 'fsv', 'kv', 'kvc', 'kvv',
  'club', 'calcio', 'cd', 'ca', 'ad', 'ec', 'sd',
  'city', 'town', 'united', 'utd',
]);

function normalizeName(raw) {
  if (!raw) return '';
  let s = String(raw)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’'´`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = s.split(' ').filter(Boolean).map(t => ABBREV[t] || t);
  const kept = tokens.filter(t => !DROP_TOKENS.has(t));
  const final = kept.length ? kept : tokens;
  return final.join('');
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------
function extractSporty(file) {
  const out = [];
  const tournaments = file?.data?.tournaments || [];
  for (const t of tournaments) {
    for (const e of t.events || []) {
      const market = (e.markets || []).find(m => String(m.id) === '1');
      if (!market) continue;
      const outcomes = market.outcomes || [];
      const home = outcomes.find(o => String(o.id) === '1');
      const draw = outcomes.find(o => String(o.id) === '2');
      const away = outcomes.find(o => String(o.id) === '3');
      if (!home || !draw || !away) continue;
      out.push({
        source: 'sporty',
        eventId: e.eventId,
        homeTeam: e.homeTeamName,
        awayTeam: e.awayTeamName,
        homeNorm: normalizeName(e.homeTeamName),
        awayNorm: normalizeName(e.awayTeamName),
        kickoff: e.estimateStartTime,
        tournament: e?.sport?.category?.tournament?.name || t.name,
        odds: {
          home: parseFloat(home.odds),
          draw: parseFloat(draw.odds),
          away: parseFloat(away.odds),
        },
      });
    }
  }
  return out;
}

function extractMsport(file) {
  const out = [];
  const tournaments = file?.data?.tournaments || [];
  for (const t of tournaments) {
    for (const e of t.events || []) {
      const market = (e.markets || []).find(m => Number(m.id) === 1);
      if (!market) continue;
      const outcomes = market.outcomes || [];
      const home = outcomes.find(o => String(o.id) === '1');
      const draw = outcomes.find(o => String(o.id) === '2');
      const away = outcomes.find(o => String(o.id) === '3');
      if (!home || !draw || !away) continue;
      
      // Apply the fake 15% boost here
      out.push({
        source: 'msport',
        eventId: e.eventId,
        homeTeam: e.homeTeam,
        awayTeam: e.awayTeam,
        homeNorm: normalizeName(e.homeTeam),
        awayNorm: normalizeName(e.awayTeam),
        kickoff: e.startTime,
        tournament: e.tournament,
        odds: {
          home: parseFloat(home.odds) * ODDS_BOOST_MULTIPLIER,
          draw: parseFloat(draw.odds) * ODDS_BOOST_MULTIPLIER,
          away: parseFloat(away.odds) * ODDS_BOOST_MULTIPLIER,
        },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matching & Math
// ---------------------------------------------------------------------------
const KICKOFF_TOLERANCE_MS = 30 * 60 * 1000; 

function sameFixture(a, b) {
  if (a.homeNorm !== b.homeNorm) return false;
  if (a.awayNorm !== b.awayNorm) return false;
  if (a.kickoff && b.kickoff && Math.abs(a.kickoff - b.kickoff) > KICKOFF_TOLERANCE_MS) {
    return false;
  }
  return true;
}

function arbPercent(a, b) {
  const bestHome = Math.max(a.odds.home, b.odds.home);
  const bestDraw = Math.max(a.odds.draw, b.odds.draw);
  const bestAway = Math.max(a.odds.away, b.odds.away);

  const invSum = 1 / bestHome + 1 / bestDraw + 1 / bestAway;
  const profitPct = (1 / invSum - 1) * 100;
  return {
    bestHome,
    bestDraw,
    bestAway,
    profitPct,
    isArb: invSum < 1,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  if (!fs.existsSync(SPORTY_FILE) || !fs.existsSync(MSPORT_FILE)) {
    console.error('Missing data files. Run fetch-odds.js first.');
    process.exit(1);
  }

  const sporty = extractSporty(JSON.parse(fs.readFileSync(SPORTY_FILE, 'utf8')));
  const msport = extractMsport(JSON.parse(fs.readFileSync(MSPORT_FILE, 'utf8')));

  console.log(`SportyBet fixtures: ${sporty.length}`);
  console.log(`MSport fixtures:    ${msport.length}`);
  console.log(`⚠️  Applied fake odds boost: +${(ODDS_BOOST_MULTIPLIER - 1) * 100}% to MSport\n`);

  const msportIndex = new Map();
  for (const m of msport) {
    const key = `${m.homeNorm}|${m.awayNorm}`;
    if (!msportIndex.has(key)) msportIndex.set(key, []);
    msportIndex.get(key).push(m);
  }

  const matched = [];
  for (const s of sporty) {
    const key = `${s.homeNorm}|${s.awayNorm}`;
    const candidates = msportIndex.get(key) || [];
    const hit = candidates.find(c => sameFixture(s, c));
    if (hit) matched.push([s, hit]);
  }

  const arbs = [];
  for (const [s, m] of matched) {
    const r = arbPercent(s, m);
    if (r.isArb) {
      arbs.push({
        home: s.homeTeam,
        away: s.awayTeam,
        tournament: s.tournament,
        kickoff: s.kickoff,
        sporty: s.odds,
        msport: m.odds,
        best: { home: r.bestHome, draw: r.bestDraw, away: r.bestAway },
        profitPct: Number(r.profitPct.toFixed(3)),
      });
    }
  }

  // Sort arbs by highest profit first
  arbs.sort((a, b) => b.profitPct - a.profitPct);

  console.log(`Matched fixtures:   ${matched.length}`);
  console.log(`Arbs found:         ${arbs.length}\n`);

  if (arbs.length === 0) {
    console.log('No arbitrage opportunities found even with the boost. Check your data.');
  } else {
    console.log(`💰 Arbitrage opportunities found:`);
    for (const a of arbs) {
      console.log(`  ${a.home} vs ${a.away} → ${a.profitPct}% (${a.tournament})`);
      console.log(`     Bet Home @ ${a.best.home.toFixed(2)} | Draw @ ${a.best.draw.toFixed(2)} | Away @ ${a.best.away.toFixed(2)}`);
    }
  }

const outPath = path.join(__dirname, '..', 'public', 'arbs.json');
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    boostApplied: ODDS_BOOST_MULTIPLIER,
    arbs,
  }, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main();