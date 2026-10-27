// scripts/fetch-soccabet.js
// Soccabet (Ghana) pre-match odds snapshot -> data/soccabet.json in canonical `sel` keys
// ("1X2:H", "DC:12", "OU:2.5:O"), the vocabulary scripts/find-arbs.js prices.
//
// Two sources, because neither is sufficient alone:
//
//   1. GET /api/sports/isd.js  (session bootstrap). Carries the site's dictionaries — sport
//      77 = Soccer, category -> sportId, tournament -> categoryId, and market_type id -> name —
//      plus a snapshot of pre-match fixtures with their 1X2 prices. This is the primary source:
//      the socket only ever serves LIVE fixtures.
//   2. wss://www.soccabet.com/ws/  pushes `match` / `market` deltas, joined to their match by
//      `marketId`. Live fixtures are skipped unless --include-live is passed.
//
//   node scripts/fetch-soccabet.js                    60s capture -> data/soccabet.json
//   node scripts/fetch-soccabet.js --seconds=180      longer socket capture
//   node scripts/fetch-soccabet.js --suffix=-test     -> data/soccabet-test.json
//   node scripts/fetch-soccabet.js --include-live     also emit in-play fixtures
//   node scripts/fetch-soccabet.js --dump-raw         save sample frames to data/soccabet-raw-*.json
//
// Wire format (verified against the live site):
//   frames     { "messages": [ { "object": "match" | "market" | ..., ... } ] }
//   match      { id, tournamentId, competitors: [home, away], startTs, isLive, isSuspended, uuid? }
//   market     { id, matchId, marketTypeId, special, isSuspended, status,
//                selections: [ { id, outcome: "1" | "X" | "2", odds } ] }
//   market_type{ id, sportId, name: "1x2", selectionType, hasSpecial }
//
// `startTs` is milliseconds on the socket and SECONDS in isd.js; both are normalised here.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const ORIGIN = opt('origin', 'https://www.soccabet.com');
const LANDING_URL = opt('landing', `${ORIGIN}/sports/today`);
const ISD_URL = opt('isd', `${ORIGIN}/api/sports/isd.js`);
const WS_URL = opt('ws', 'wss://www.soccabet.com/ws/');
const SESSION_COOKIE = opt('cookie-name', 'USERSESSION');
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/155.0.0.0 Safari/537.36';

const SOCCER_SPORT_ID = 77;

const WINDOW_DAYS = Math.max(1, Number(opt('days', '2')) || 2);
const CAPTURE_SECONDS = Math.max(5, Number(opt('seconds', '60')) || 60);
const FILE_SUFFIX = opt('suffix', '');
const INCLUDE_LIVE = has('include-live');
const DUMP_RAW = has('dump-raw');
const RAW_LIMIT = Math.max(1, Number(opt('dump-limit', '25')) || 25);
const MAX_RECONNECTS = Math.max(0, Number(opt('reconnects', '3')) || 0);

const OUT_FILE = path.join(DATA_DIR, `soccabet${FILE_SUFFIX}.json`);

const NOW = Date.now();
const CUTOFF = NOW + WINDOW_DAYS * 24 * 60 * 60 * 1000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/** Unknown kickoffs are kept: find-arbs.js then joins on team names alone. */
function withinWindow(ts) {
  if (!Number.isFinite(ts)) return true;
  return ts >= NOW - 60 * 60 * 1000 && ts <= CUTOFF;
}

/** Epoch seconds (isd.js), epoch ms (socket), or an ISO string -> ms. */
function toMs(value) {
  if (value == null) return null;
  if (typeof value === 'number' || /^\d{9,}$/.test(String(value))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e12 ? n * 1000 : n;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

// ============================================================================
// Session
// ============================================================================

function readSetCookies(headers) {
  const raw =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie')].filter(Boolean);

  return raw
    .map((line) => {
      const [pair] = String(line).split(';');
      const index = pair.indexOf('=');
      if (index < 1) return null;
      return { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim() };
    })
    .filter(Boolean);
}

/** The socket handshake needs a browser session; the landing page sets it. */
async function captureSession() {
  console.log(`🍪 Fetching ${LANDING_URL} for the session cookie...`);

  const res = await fetch(LANDING_URL, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': USER_AGENT,
    },
    redirect: 'follow',
  });

  if (!res.ok) throw new Error(`landing page HTTP ${res.status}`);

  const cookies = readSetCookies(res.headers);
  const session = cookies.find((c) => c.name === SESSION_COOKIE);
  await res.text().catch(() => {});

  if (!session) {
    const seen = cookies.map((c) => c.name).join(', ') || 'none';
    throw new Error(`${SESSION_COOKIE} not set by the landing page (cookies seen: ${seen})`);
  }

  console.log(`   ✅ ${SESSION_COOKIE} captured (${session.value.length} chars).`);
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

// ============================================================================
// Subscription frame — REPLACE ONCE SNIFFED
// ============================================================================

function readSubscribeFrame() {
  const fromEnv = String(process.env.SOCCABET_SUBSCRIBE ?? '').trim();
  if (fromEnv) return fromEnv;

  try {
    return fs.readFileSync(path.join(DATA_DIR, 'soccabet-subscribe.json'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Sends the subscription frame after the socket opens.
 *
 * The site auto-subscribes each client to `primaryfixtures` (the server acks id 1 on its own),
 * and that channel only carries live fixtures. Subscribe objects tried so far
 * (market_type/tournament/category/sport/match/fixtures/...) are ignored, so a pre-match channel
 * name — if one exists — still has to be sniffed from DevTools.
 *
 * Set it in code, in data/soccabet-subscribe.json, or in SOCCABET_SUBSCRIBE.
 *
 * @param {WebSocket} ws
 * @returns {boolean} true when a frame was sent
 */
function subscribeToSoccabet(ws) {
  const frame = readSubscribeFrame();

  if (!frame) {
    console.log(
      '   ⚠️  No subscribe frame configured — taking the server\'s default (live fixtures).\n' +
        '       Pre-match data still comes from isd.js.',
    );
    return false;
  }

  try {
    ws.send(frame);
    const preview = frame.length > 120 ? `${frame.slice(0, 120)}…` : frame;
    console.log(`   ↗ Sent subscribe frame: ${preview}`);
    return true;
  } catch (error) {
    console.log(`   ✖ Subscribe frame failed: ${error.message}`);
    return false;
  }
}

// ============================================================================
// Store
// ============================================================================

const state = {
  matches: new Map(), // matchId -> match
  markets: new Map(), // matchId -> Map(marketId -> market)
  sports: new Map(), // sportId -> sport
  categories: new Map(), // categoryId -> category
  tournaments: new Map(), // tournamentId -> tournament
  marketTypes: new Map(), // marketTypeId -> market_type
  frames: 0,
  parsed: 0,
  unparsed: 0,
  isdObjects: 0,
  unknownObjects: new Map(),
  unknownMarketTypes: new Map(),
  incompleteMarkets: 0,
  rawSamples: [],
};

function storeMarket(market) {
  if (!market?.id || !market.matchId) return;
  const byId = state.markets.get(market.matchId) ?? new Map();
  // Deltas carry partial markets; merge so a later frame only has to send what changed.
  byId.set(market.id, { ...byId.get(market.id), ...market });
  state.markets.set(market.matchId, byId);
}

/**
 * Routes one `object` payload into the store. Matches, markets and dictionary entries all arrive
 * in the same shape whether they come from isd.js or from a socket frame.
 */
function ingestObject(object) {
  if (!isObject(object)) return;

  switch (object.object) {
    case 'match':
      if (object.id != null) {
        state.matches.set(object.id, { ...state.matches.get(object.id), ...object });
      }
      return;
    case 'market':
      storeMarket(object);
      return;
    case 'market_type':
      if (object.id != null) state.marketTypes.set(object.id, object);
      return;
    case 'sport':
      if (object.id != null) state.sports.set(object.id, object);
      return;
    case 'category':
      if (object.id != null) state.categories.set(object.id, object);
      return;
    case 'tournament':
      if (object.id != null) state.tournaments.set(object.id, object);
      return;
    case 'init':
      return; // handshake marker, nothing to keep
    default:
      state.unknownObjects.set(object.object, (state.unknownObjects.get(object.object) ?? 0) + 1);
  }
}

function ingestPayload(payload) {
  if (Array.isArray(payload)) {
    for (const item of payload) ingestPayload(item);
    return;
  }
  if (!isObject(payload)) return;

  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) ingestObject(message);
    return;
  }

  // The server echoes subscriptions as { subscription: { request, id } }.
  if (payload.subscription) return;
  if (payload.object) ingestObject(payload);
}

function ingestFrame(data) {
  state.frames += 1;

  const text = Buffer.isBuffer(data)
    ? data.toString('utf8')
    : typeof data === 'string'
      ? data
      : String(data);

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    state.unparsed += 1;
    return;
  }

  state.parsed += 1;
  if (DUMP_RAW && state.rawSamples.length < RAW_LIMIT) state.rawSamples.push(payload);
  ingestPayload(payload);
}

// ============================================================================
// isd.js catalogue (primary pre-match source)
// ============================================================================

async function fetchIsd(cookie) {
  console.log(`📚 Fetching ${ISD_URL} ...`);

  const res = await fetch(`${ISD_URL}?t=${Date.now()}`, {
    headers: {
      Accept: '*/*',
      Referer: LANDING_URL,
      'User-Agent': USER_AGENT,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });

  if (!res.ok) throw new Error(`isd.js HTTP ${res.status}`);

  const body = await res.text();
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('isd.js did not contain a JSON array');

  const objects = JSON.parse(body.slice(start, end + 1));
  for (const object of objects) ingestObject(object);
  state.isdObjects = objects.length;

  const prematch = [...state.matches.values()].filter((m) => m.isLive === false).length;
  console.log(
    `   ✅ ${objects.length} catalogue objects ` +
      `(${state.matches.size} matches, ${prematch} pre-match, ${state.marketTypes.size} market types).`,
  );
}

// ============================================================================
// Socket (live deltas + any channel the server chooses to push)
// ============================================================================

function captureSocket(cookieHeader) {
  return new Promise((resolve) => {
    const deadline = Date.now() + CAPTURE_SECONDS * 1000;
    let attempts = 0;
    let finished = false;
    let ws = null;

    const finish = (reason) => {
      if (finished) return;
      finished = true;
      clearInterval(budget);
      try {
        ws?.close();
      } catch {}
      console.log(`\n⏹  Capture stopped (${reason}).`);
      resolve();
    };

    const budget = setInterval(() => {
      if (Date.now() >= deadline) finish('capture window elapsed');
    }, 500);

    const open = () => {
      attempts += 1;
      console.log(`📡 Connecting to ${WS_URL} (attempt ${attempts})...`);

      ws = new WebSocket(WS_URL, {
        origin: ORIGIN,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Language': 'en-US,en;q=0.9',
          Cookie: cookieHeader,
        },
        handshakeTimeout: 15_000,
        perMessageDeflate: false,
      });

      ws.on('open', () => {
        console.log('   ✅ Socket open.');
        subscribeToSoccabet(ws);
      });

      ws.on('message', ingestFrame);

      ws.on('unexpected-response', (_request, response) => {
        console.log(`   ⚠️  Handshake rejected with HTTP ${response.statusCode}.`);
      });

      ws.on('error', (error) => {
        console.log(`   ⚠️  Socket error: ${error.message}`);
      });

      ws.on('close', (code, reason) => {
        if (finished) return;
        const detail = reason?.length ? `: ${reason.toString()}` : '';
        if (Date.now() >= deadline || attempts > MAX_RECONNECTS) {
          finish(`closed (${code}${detail})`);
          return;
        }
        console.log(`   ↻ Closed (${code}${detail}). Reconnecting in 3s...`);
        setTimeout(() => {
          if (!finished) open();
        }, 3000);
      });
    };

    process.once('SIGINT', () => finish('SIGINT'));
    open();
  });
}

// ============================================================================
// Market mapping
// ============================================================================

/** market_type name -> canonical market kind. */
const KIND_RULES = [
  { kind: '1X2', re: /^1\s*x\s*2$|^match ?result$|^match ?winner$/i },
  { kind: 'DC', re: /double ?chance|^dc$/i },
  { kind: 'BTTS', re: /both teams to score|^btts$|^gg\s*\/?\s*ng$/i },
  { kind: 'OU', re: /over\s*\/?\s*under|^total ?goals?$|^totals?$|goals? over\s*\/?\s*under/i },
];

function kindOf(type) {
  const name = String(type?.name ?? type?.shortName ?? '').trim();
  if (!name) return null;
  return KIND_RULES.find((rule) => rule.re.test(name))?.kind ?? null;
}

/** Line for an Over/Under market: `special` holds it (e.g. "2.5", "total=2.5"). */
function lineOf(market) {
  const special = String(market?.special ?? '');
  const match = special.match(/(\d+(?:\.\d+)?)/);
  return match ? match[1] : null;
}

const RESULT_SIDES = { 1: 'H', x: 'D', 2: 'A' };
const DC_SIDES = { '1x': '1X', 12: '12', x2: 'X2' };
const OU_SIDES = { over: 'O', under: 'U' };

/**
 * Maps one market onto canonical `sel` keys, or null when it is not a market we price.
 *
 * A market is only accepted when it is *complete* (a partial 1X2 would let find-arbs pair, say,
 * a lone draw price against a double chance and invent an arb that cannot be placed).
 */
function canonicalMarket(market) {
  const type = state.marketTypes.get(market.marketTypeId);
  if (!type) {
    state.unknownMarketTypes.set(
      market.marketTypeId,
      (state.unknownMarketTypes.get(market.marketTypeId) ?? 0) + 1,
    );
    return null;
  }

  if (type.sportId != null && type.sportId !== SOCCER_SPORT_ID) return null;
  if (market.isSuspended === true || market.isDeleted === true) return null;
  const status = String(market.status ?? 'open').toLowerCase();
  if (status && status !== 'open') return null;

  const kind = kindOf(type);
  if (!kind) return null;

  const prices = {};
  for (const selection of market.selections ?? []) {
    const price = num(selection?.odds);
    // 0 and 1 are "no price" placeholders on this platform, never real quotes.
    if (price === null || price <= 1) continue;
    const side = String(selection?.outcome ?? selection?.name ?? '').trim().toLowerCase();
    if (side) prices[side] = price;
  }

  const sel = {};

  if (kind === '1X2') {
    if (!('1' in prices) || !('x' in prices) || !('2' in prices)) {
      state.incompleteMarkets += 1;
      return null;
    }
    for (const [side, suffix] of Object.entries(RESULT_SIDES)) sel[`1X2:${suffix}`] = prices[side];
    return sel;
  }

  if (kind === 'DC') {
    if (!('1x' in prices) || !('12' in prices) || !('x2' in prices)) {
      state.incompleteMarkets += 1;
      return null;
    }
    for (const [side, suffix] of Object.entries(DC_SIDES)) sel[`DC:${suffix}`] = prices[side];
    return sel;
  }

  if (kind === 'BTTS') {
    if (!('yes' in prices) || !('no' in prices)) {
      state.incompleteMarkets += 1;
      return null;
    }
    sel['BTTS:Y'] = prices.yes;
    sel['BTTS:N'] = prices.no;
    return sel;
  }

  if (kind === 'OU') {
    const line = lineOf(market);
    if (!line || !line.endsWith('.5')) return null;
    if (!('over' in prices) || !('under' in prices)) {
      state.incompleteMarkets += 1;
      return null;
    }
    for (const [side, suffix] of Object.entries(OU_SIDES)) sel[`OU:${line}:${suffix}`] = prices[side];
    return sel;
  }

  return null;
}

// ============================================================================
// Build + output
// ============================================================================

function sportIdOf(match) {
  if (match.sportId != null) return match.sportId;
  const tournament = state.tournaments.get(match.tournamentId);
  if (!tournament) return null;
  const category = state.categories.get(tournament.categoryId);
  return category?.sportId ?? null;
}

function buildEvents() {
  const events = [];
  const skipped = { live: 0, sport: 0, window: 0, empty: 0 };
  const kindCounts = {};

  for (const match of state.matches.values()) {
    if (match.isLive === true && !INCLUDE_LIVE) {
      skipped.live += 1;
      continue;
    }

    if (sportIdOf(match) !== SOCCER_SPORT_ID) {
      skipped.sport += 1;
      continue;
    }

    const kickoff = toMs(match.startTs);
    if (!withinWindow(kickoff)) {
      skipped.window += 1;
      continue;
    }

    const sel = {};
    for (const market of state.markets.get(match.id)?.values() ?? []) {
      const mapped = canonicalMarket(market);
      if (!mapped) continue;
      Object.assign(sel, mapped);
      const kind = kindOf(state.marketTypes.get(market.marketTypeId)) ?? 'other';
      kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
    }

    const [home, away] = Array.isArray(match.competitors) ? match.competitors : [];
    if (!home || !away || Object.keys(sel).length === 0) {
      skipped.empty += 1;
      continue;
    }

    const tournament = state.tournaments.get(match.tournamentId);
    const category = state.categories.get(tournament?.categoryId);

    events.push({
      // No Sportradar id on this book, so the id is namespaced; find-arbs.js falls back to
      // team-name + kickoff matching for anything that is not `sr:match:`.
      eventId: `soccabet:${match.uuid ?? match.id}`,
      soccabetId: String(match.id),
      code: match.code ?? null,
      league: tournament
        ? [category?.name, tournament.name].filter(Boolean).join(' · ')
        : null,
      home,
      away,
      kickoff,
      isLive: match.isLive === true,
      sel,
    });
  }

  events.sort((a, b) => (a.kickoff ?? Infinity) - (b.kickoff ?? Infinity));
  return { events, skipped, kindCounts };
}

function printSummary(skipped, kindCounts) {
  console.log('\n📊 Capture summary');
  console.log(`   isd:       ${state.isdObjects} catalogue objects`);
  console.log(`   socket:    ${state.frames} frames (${state.parsed} JSON, ${state.unparsed} unparsed)`);
  console.log(`   matches:   ${state.matches.size} seen, skipped ${skipped.live} live / ${skipped.sport} non-soccer / ${skipped.window} out-of-window / ${skipped.empty} unpriced`);
  console.log(`   markets:   ${Object.entries(kindCounts).map(([k, n]) => `${k} ${n}`).join(' | ') || 'none'}`);
  if (state.incompleteMarkets > 0) {
    console.log(`   partial:   ${state.incompleteMarkets} market(s) dropped for missing prices`);
  }
  if (state.unknownMarketTypes.size > 0) {
    const list = [...state.unknownMarketTypes.entries()].map(([id, n]) => `${id}×${n}`).join(', ');
    console.log(`   unknown:   market types not in the catalogue: ${list}`);
  }
  if (state.unknownObjects.size > 0) {
    const list = [...state.unknownObjects.entries()].map(([k, n]) => `${k}×${n}`).join(', ');
    console.log(`   objects:   unhandled payload types: ${list}`);
  }
}

function dumpRaw() {
  if (!DUMP_RAW) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(DATA_DIR, `soccabet-raw-${stamp}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ capturedAt: new Date().toISOString(), url: WS_URL, frames: state.rawSamples }, null, 2),
  );
  console.log(`💾 Saved ${state.rawSamples.length} raw frame(s) to ${file}.`);
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log(
    `Window: now → ${new Date(CUTOFF).toISOString()} ` +
      `(${WINDOW_DAYS} days, ${CAPTURE_SECONDS}s socket${INCLUDE_LIVE ? ', including live' : ''})\n`,
  );

  const cookie = await captureSession().catch((error) => {
    console.log(`   ⚠️  ${error.message} — continuing without a session (socket will be skipped).`);
    return null;
  });

  await fetchIsd(cookie);

  if (cookie) {
    await captureSocket(cookie);
  } else {
    console.log('⏭  Skipping the socket: no session cookie.');
  }

  const { events, skipped, kindCounts } = buildEvents();

  printSummary(skipped, kindCounts);
  dumpRaw();

  if (events.length === 0) {
    console.error(
      '\n❌ No soccer odds captured; leaving any existing snapshot untouched.\n' +
        '   Check the summary above: catalogue gaps (unknown market types) are the usual cause.',
    );
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), source: 'Soccabet', windowDays: WINDOW_DAYS, events },
      null,
      2,
    ),
  );

  const prematch = events.filter((event) => !event.isLive).length;
  console.log(`\n💾 Saved ${events.length} matches (${prematch} pre-match) to ${OUT_FILE}`);
}

main().catch((error) => {
  console.error(`❌ Soccabet capture failed: ${error.message}`);
  process.exitCode = 1;
});
