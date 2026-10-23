import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const SPORTY_FILE = path.join(DATA_DIR, 'sportybet.json');
const MSPORT_FILE = path.join(DATA_DIR, 'msport.json');

// ⚠️ FAKE ODDS BOOST (For testing the math logic)
const ODDS_BOOST_MULTIPLIER = 1.15; 

// ---------------------------------------------------------------------------
// Name Normalization
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
  'club', 'calcio', 'cd', 'ca', 'ad', 'ec', 'sd', 'city', 'town', 'united', 'utd',
]);

function normalizeName(raw) {
  if (!raw) return '';
  let s = String(raw).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[’'´`]/g, '').replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const tokens = s.split(' ').filter(Boolean).map(t => ABBREV[t] || t);
  const kept = tokens.filter(t => !DROP_TOKENS.has(t));
  return (kept.length ? kept : tokens).join('');
}

// Helper to normalize market/outcome strings so Sporty and MSport match
function cleanString(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------
function extractSporty(file) {
  const out = [];
  for (const t of file?.data?.tournaments || []) {
    for (const e of t.events || []) {
      const markets = {};
      for (const m of e.markets || []) {
        // Clean the market name (e.g., "Over/Under", "1X2", "GG/NG")
        const mName = cleanString(m.name || m.description || '');
        if (!mName) continue;

        markets[mName] = {};
        for (const o of m.outcomes || []) {
          // Clean the outcome name (e.g., "Home", "Over 2.5", "Yes")
          const oName = cleanString(o.description || o.desc || '');
          if (!oName) continue;

          markets[mName][oName] = {
            bookie: 'SportyBet',
            odds: parseFloat(o.odds),
            specifier: m.specifiers || ''
          };
        }
      }
      out.push({
        homeTeam: e.homeTeamName, awayTeam: e.awayTeamName,
        homeNorm: normalizeName(e.homeTeamName), awayNorm: normalizeName(e.awayTeamName),
        kickoff: e.estimateStartTime,
        tournament: e?.sport?.category?.tournament?.name || t.name,
        markets
      });
    }
  }
  return out;
}

function extractMsport(file) {
  const out = [];
  for (const t of file?.data?.tournaments || []) {
    for (const e of t.events || []) {
      const markets = {};
      for (const m of e.markets || []) {
        const mName = cleanString(m.name || m.description || '');
        if (!mName) continue;

        markets[mName] = {};
        for (const o of m.outcomes || []) {
          const oName = cleanString(o.description || o.desc || '');
          if (!oName) continue;

          markets[mName][oName] = {
            bookie: 'MSport',
            odds: parseFloat(o.odds) * ODDS_BOOST_MULTIPLIER, // Apply boost here
            specifier: m.specifiers || ''
          };
        }
      }
      out.push({
        homeTeam: e.homeTeam, awayTeam: e.awayTeam,
        homeNorm: normalizeName(e.homeTeam), awayNorm: normalizeName(e.awayTeam),
        kickoff: e.startTime,
        tournament: e.tournament,
        markets
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
  if (a.homeNorm !== b.homeNorm || a.awayNorm !== b.awayNorm) return false;
  if (a.kickoff && b.kickoff && Math.abs(a.kickoff - b.kickoff) > KICKOFF_TOLERANCE_MS) return false;
  return true;
}

// Find 2-way arbs within a specific market
function findArbsInMarket(sMarket, mMarket, marketName) {
  const arbs = [];
  const sOutcomes = Object.keys(sMarket);
  
  // Check every possible pair of outcomes (e.g., Home vs Away, Over vs Under)
  for (let i = 0; i < sOutcomes.length; i++) {
    for (let j = i + 1; j < sOutcomes.length; j++) {
      const outA = sOutcomes[i];
      const outB = sOutcomes[j];

      // Make sure MSport actually has these same two outcomes
      if (!mMarket[outA] || !mMarket[outB]) continue;

      // 1. Get the best odds for Side A
      const bestA = sMarket[outA].odds > mMarket[outA].odds 
        ? sMarket[outA] : mMarket[outA];
      
      // 2. Get the best odds for Side B
      const bestB = sMarket[outB].odds > mMarket[outB].odds 
        ? sMarket[outB] : mMarket[outB];

      // 3. Do the 2-way arb math
      const invSum = (1 / bestA.odds) + (1 / bestB.odds);
      
      if (invSum < 1) {
        const profitPct = ((1 / invSum) - 1) * 100;
        arbs.push({
          market: marketName,
          profitPct: Number(profitPct.toFixed(3)),
          legs: [
            { bookmaker: bestA.bookie, outcome: outA, odds: bestA.odds },
            { bookmaker: bestB.bookie, outcome: outB, odds: bestB.odds }
          ]
        });
      }
    }
  }
  return arbs;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
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

  const allArbs = [];

  for (const s of sporty) {
    const candidates = msportIndex.get(`${s.homeNorm}|${s.awayNorm}`) || [];
    const m = candidates.find(c => sameFixture(s, c));
    if (!m) continue;

    // Loop through every market SportyBet has
    for (const marketName of Object.keys(s.markets)) {
      // If MSport has this exact same market
      if (m.markets[marketName]) {
        const marketArbs = findArbsInMarket(s.markets[marketName], m.markets[marketName], marketName);
        
        // If we found an arb, attach the match details
        for (const arb of marketArbs) {
          allArbs.push({
            home: s.homeTeam,
            away: s.awayTeam,
            tournament: s.tournament,
            kickoff: s.kickoff,
            ...arb
          });
        }
      }
    }
  }

  // Sort arbs by highest profit first
  allArbs.sort((a, b) => b.profitPct - a.profitPct);

  console.log(`Total Arbs Found: ${allArbs.length}\n`);

  if (allArbs.length > 0) {
    console.log(`💰 Top 5 Arbitrage Opportunities:`);
    for (const a of allArbs.slice(0, 5)) { 
      console.log(`  ${a.home} vs ${a.away} → ${a.profitPct}% [Market: ${a.market}]`);
      console.log(`     ${a.legs[0].bookmaker}: ${a.legs[0].outcome} @ ${a.legs[0].odds.toFixed(2)}`);
      console.log(`     ${a.legs[1].bookmaker}: ${a.legs[1].outcome} @ ${a.legs[1].odds.toFixed(2)}`);
    }
  }

  const outPath = path.join(__dirname, '..', 'public', 'arbs.json');
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    boostApplied: ODDS_BOOST_MULTIPLIER,
    arbs: allArbs,
  }, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main();