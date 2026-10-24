#!/usr/bin/env node
'use strict';

/**
 * Temporary discovery helper for the 3-way arbitrage scanner.
 *
 * Reads data/sportybet.json, data/msport.json and data/betboro.json,
 * samples the first N matches from each, and prints which markets exist
 * on which bookmaker, grouped into canonical market families.
 *
 * Usage:
 *   node scripts/discover-markets.js        # first 5 matches per bookie
 *   node scripts/discover-markets.js 10     # first 10 matches per bookie
 *
 * This script only reads and reports. It does not modify anything.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MATCH_LIMIT = Math.max(1, Number(process.argv[2]) || 5);

const BOOKS = [
  { id: 'sb', label: 'SportyBet', file: 'sportybet.json' },
  { id: 'ms', label: 'MSport', file: 'msport.json' },
  { id: 'bb', label: 'BetBoro', file: 'betboro.json' },
];

/* ------------------------------------------------------------------ *
 * Canonical market family inference
 * ------------------------------------------------------------------ */

const FAMILY_RULES = [
  [/^(1 ?x ?2|match result|full ?time result|ftr|moneyline|ml)$/, 'MATCH_RESULT'],
  [/double chance/, 'DOUBLE_CHANCE'],
  [/draw no bet|\bdnb\b/, 'DRAW_NO_BET'],
  [/both teams to score|\bbtts\b|\bgg ?ng\b|gg\/ng/, 'BTTS'],
  [/correct score/, 'CORRECT_SCORE'],
  [/half ?time ?\/? ?full ?time|\bht ?\/? ?ft\b|\bhtft\b/, 'HTFT'],
  [/exact (total )?goals|total goals exact/, 'EXACT_TOTAL_GOALS'],
  [/corner (asian )?handicap|handicap corners?/, 'CORNER_HANDICAP'],
  [/corners?/, 'TOTAL_CORNERS'],
  [/(card|booking)s? (asian )?handicap|handicap (cards|bookings)/, 'CARD_HANDICAP'],
  [/(total )?(cards?|bookings?|yellow cards?)/, 'TOTAL_CARDS'],
  [/team total|home total|away total/, 'TEAM_TOTAL_GOALS'],
  [/total goals|goals over ?\/? ?under|over ?\/? ?under|goal line|^total$/, 'TOTAL_GOALS'],
  [/(asian )?handicap|^ah$|\bspread\b/, 'HANDICAP'],
  [/odd ?\/? ?even|odd or even/, 'ODD_EVEN'],
  [/clean sheet/, 'CLEAN_SHEET'],
  [/win to nil/, 'WIN_TO_NIL'],
  [/multi ?goal|multigoal/, 'MULTIGOAL'],
  [/penalty/, 'PENALTY'],
  [/throw ?in/, 'THROW_INS'],
  [/offside/, 'OFFSIDES'],
  [/shots?/, 'SHOTS'],
  [/goal ?keeper|goalkeeper/, 'GOALKEEPER'],
  [/^winner$/, 'OUTRIGHT_WINNER'],
];

/** Lowercase and strip punctuation so "1,X,2" and "Match_Result" normalise. */
function normalizeName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[_\-/|]+/g, ' ')
    .replace(/[^a-z0-9. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Returns a canonical family key for a raw market name. */
function inferFamily(rawName) {
  const n = normalizeName(rawName);
  if (!n) return 'UNKNOWN';

  let family = 'UNMAPPED';
  for (const [re, key] of FAMILY_RULES) {
    if (re.test(n)) {
      family = key;
      break;
    }
  }

  // Half-scoped variants (skip HTFT, which is already a combined market).
  if (family !== 'HTFT' && family !== 'UNMAPPED') {
    if (/1st half|first half|half 1|^ht\b|\bht\b/.test(n)) family = `HT_${family}`;
    else if (/2nd half|second half|half 2/.test(n)) family = `SH_${family}`;
  }

  return family;
}

/**
 * Best-effort line extraction: "Over 2.5" -> "2.5",
 * "Total Goals 3.5" -> "3.5", "Total Corners 9.5" -> "9.5".
 */
function inferLine(rawName, outcomeLabels) {
  const fromName = String(rawName).match(/(\d+(?:\.\d+)?)/);
  if (fromName) return fromName[1];
  for (const label of outcomeLabels) {
    const m = String(label).match(/(?:over|under|o|u)\s*(\d+(?:\.\d+)?)/i);
    if (m) return m[1];
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Per-bookmaker extraction -> [{ raw, group, line, outcomeCount }]
 * ------------------------------------------------------------------ */

function flattenTournamentEvents(json, limit) {
  const events = [];
  const tournaments = (json && json.data && json.data.tournaments) || [];
  for (const t of tournaments) {
    for (const ev of (t && t.events) || []) {
      if (events.length >= limit) return events;
      events.push(ev);
    }
  }
  return events;
}

function marketsFromSportybetEvent(ev) {
  return ((ev && ev.markets) || []).map((m) => {
    const raw = m.name || m.desc || String(m.id);
    const labels = ((m.outcomes) || []).map((o) => o.desc || o.description || '');
    return {
      raw,
      group: m.group || null,
      line: inferLine(raw, labels),
      outcomeCount: labels.length,
    };
  });
}

function marketsFromMsportEvent(ev) {
  return ((ev && ev.markets) || []).map((m) => {
    const raw = m.name || m.description || String(m.id);
    const labels = ((m.outcomes) || []).map((o) => o.description || o.desc || '');
    return {
      raw,
      group: m.group || null,
      line: (m.specifiers && String(m.specifiers).trim()) || inferLine(raw, labels),
      outcomeCount: labels.length,
    };
  });
}

function marketsFromBetboroFixture(fx) {
  const markets = (fx && fx.markets) || {};
  return Object.entries(markets).map(([key, value]) => {
    const entries = Object.values(value || {});
    // Nested-by-line shape: { "2.5": { "0": {...price}, "1": {...} } }
    const nested = entries.length > 0 &&
      !entries.some((e) => e && typeof e === 'object' && 'price' in e);

    let labels = [];
    let line = null;

    if (nested) {
      for (const [lineKey, sub] of Object.entries(value)) {
        for (const o of Object.values(sub || {})) {
          if (o && typeof o === 'object') labels.push(o.short || o.name || '');
        }
      }
      const lineKeys = Object.keys(value);
      line = lineKeys.length === 1 ? lineKeys[0] : `${lineKeys.length} lines`;
    } else {
      labels = entries.map((o) => (o && (o.short || o.name)) || '');
      line = inferLine(key, labels);
    }

    return {
      raw: key,
      group: nested ? 'parameterised' : 'flat',
      line,
      outcomeCount: labels.length,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Aggregation
 * ------------------------------------------------------------------ */

function emptyBookMap(make) {
  return { sb: make(), ms: make(), bb: make() };
}

function aggregate(samples) {
  const families = new Map(); // family -> { names, lines, hits }
  const rawInventory = emptyBookMap(() => new Map()); // raw -> count

  for (const book of BOOKS) {
    for (const market of samples[book.id].markets) {
      const family = inferFamily(market.raw);

      if (!families.has(family)) {
        families.set(family, {
          names: emptyBookMap(() => new Set()),
          lines: emptyBookMap(() => new Set()),
          hits: { sb: 0, ms: 0, bb: 0 },
        });
      }

      const entry = families.get(family);
      entry.names[book.id].add(market.raw);
      entry.hits[book.id] += 1;
      if (market.line) entry.lines[book.id].add(market.line);

      const inv = rawInventory[book.id];
      inv.set(market.raw, (inv.get(market.raw) || 0) + 1);
    }
  }

  return { families, rawInventory };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const MAX_COL = 44;

function truncate(s, width) {
  const str = String(s == null ? '' : s);
  if (str.length <= width) return str;
  return `${str.slice(0, Math.max(0, width - 2))}..`;
}

function renderTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.min(MAX_COL, Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length))));

  const sep = `+${widths.map((w) => '-'.repeat(w + 2)).join('+')}+`;
  const fmt = (cells) =>
    `|${cells.map((c, i) => ` ${truncate(c, widths[i]).padEnd(widths[i])} `).join('|')}|`;

  const out = [sep, fmt(headers), sep];
  for (const r of rows) out.push(fmt(r));
  out.push(sep);
  return out.join('\n');
}

function section(title) {
  return `\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`;
}

function fmtNames(set, limit = 3) {
  const names = [...set];
  if (names.length === 0) return '-';
  const shown = names.slice(0, limit).join(' , ');
  return names.length > limit ? `${shown} (+${names.length - limit})` : shown;
}

function fmtLines(set, limit = 8) {
  const lines = [...set].sort((a, b) => parseFloat(a) - parseFloat(b));
  const shown = lines.slice(0, limit).join(', ');
  return lines.length > limit ? `${shown} (+${lines.length - limit})` : shown;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

function main() {
  const samples = {};
  const loadErrors = [];

  for (const book of BOOKS) {
    const filePath = path.join(DATA_DIR, book.file);
    try {
      const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      let matches;
      let markets;

      if (book.id === 'bb') {
        matches = (json.fixtures || []).slice(0, MATCH_LIMIT);
        markets = matches.flatMap(marketsFromBetboroFixture);
      } else {
        matches = flattenTournamentEvents(json, MATCH_LIMIT);
        const extractor = book.id === 'sb' ? marketsFromSportybetEvent : marketsFromMsportEvent;
        markets = matches.flatMap(extractor);
      }

      samples[book.id] = { matches: matches.length, markets };
    } catch (err) {
      loadErrors.push(`${book.file}: ${err.message}`);
      samples[book.id] = { matches: 0, markets: [] };
    }
  }

  const { families, rawInventory } = aggregate(samples);

  console.log(`\nMarket discovery - first ${MATCH_LIMIT} match(es) per bookmaker`);
  console.log(`Data dir: ${DATA_DIR}`);

  if (loadErrors.length) {
    console.log('\nLOAD ERRORS:');
    for (const e of loadErrors) console.log(`  ! ${e}`);
  }

  // ---- Coverage summary -------------------------------------------------
  console.log(section('1. SAMPLE COVERAGE'));
  const coverageRows = BOOKS.map((b) => {
    const s = samples[b.id];
    const unique = rawInventory[b.id].size;
    return [b.label, s.matches, s.markets.length, unique];
  });
  console.log(renderTable(
    ['Bookmaker', 'Matches', 'Markets seen', 'Unique market keys'],
    coverageRows,
  ));

  // ---- Cross-bookie family map -----------------------------------------
  const allFamilies = [...families.entries()]
    .map(([family, v]) => {
      const books = ['sb', 'ms', 'bb'].filter((id) => v.names[id].size > 0);
      return { family, ...v, books };
    })
    .sort((a, b) => b.books.length - a.books.length || a.family.localeCompare(b.family));

  const shared = allFamilies.filter((f) => f.books.length === 3);
  const partial = allFamilies.filter((f) => f.books.length === 2);

  console.log(section(`2. MARKET FAMILY MAP (all ${allFamilies.length} families)`));
  console.log(renderTable(
    ['Market family', 'SportyBet', 'MSport', 'BetBoro', 'Books'],
    allFamilies.map((f) => [
      f.family,
      fmtNames(f.names.sb),
      fmtNames(f.names.ms),
      fmtNames(f.names.bb),
      `${f.books.length}/3`,
    ]),
  ));

  // ---- Parameterised market lines --------------------------------------
  const withLines = allFamilies.filter((f) =>
    f.lines.sb.size || f.lines.ms.size || f.lines.bb.size);

  if (withLines.length) {
    console.log(section('3. LINE / HANDICAP VALUES OBSERVED (parameterised markets)'));
    console.log(renderTable(
      ['Market family', 'SportyBet lines', 'MSport lines', 'BetBoro lines'],
      withLines.map((f) => [
        f.family,
        f.lines.sb.size ? fmtLines(f.lines.sb) : '-',
        f.lines.ms.size ? fmtLines(f.lines.ms) : '-',
        f.lines.bb.size ? fmtLines(f.lines.bb) : '-',
      ]),
    ));
  }

  // ---- Raw inventory per bookie ----------------------------------------
  console.log(section('4. RAW MARKET KEY INVENTORY PER BOOKMAKER'));
  for (const b of BOOKS) {
    const inv = rawInventory[b.id];
    if (inv.size === 0) {
      console.log(`\n-- ${b.label}: no markets (${samples[b.id].matches} matches)`);
      continue;
    }
    const rows = [...inv.entries()]
      .sort((a, b2) => b2[1] - a[1] || a[0].localeCompare(b2[0]))
      .map(([raw, count]) => [raw, count, inferFamily(raw)]);
    console.log(`\n-- ${b.label} (${inv.size} unique keys, ${samples[b.id].matches} matches)`);
    console.log(renderTable(['Raw market key', 'Occurrences', 'Inferred family'], rows));
  }

  // ---- Actionable overlap summary --------------------------------------
  console.log(section('5. OVERLAP SUMMARY'));
  console.log(`Families on all 3 bookies : ${shared.length}`);
  console.log(`Families on exactly 2     : ${partial.length}`);
  console.log(`Families on only 1        : ${allFamilies.filter((f) => f.books.length === 1).length}`);

  if (shared.length) {
    console.log('\n3-way overlap (safe starting point for find-arbs.js):');
    for (const f of shared) {
      console.log(`  * ${f.family}`);
      console.log(`      sb="${fmtNames(f.names.sb, 4)}"  ms="${fmtNames(f.names.ms, 4)}"  bb="${fmtNames(f.names.bb, 4)}"`);
    }
  }

  const unmapped = allFamilies.filter((f) => f.family === 'UNMAPPED' || f.family === 'UNKNOWN');
  if (unmapped.length) {
    console.log('\nUnmapped names (extend FAMILY_RULES if relevant):');
    for (const f of unmapped) {
      console.log(`  ? sb="${fmtNames(f.names.sb, 4)}"  ms="${fmtNames(f.names.ms, 4)}"  bb="${fmtNames(f.names.bb, 4)}"`);
    }
  }

  console.log('');
}

main();
