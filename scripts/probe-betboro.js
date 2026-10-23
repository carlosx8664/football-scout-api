// scripts/probe-betboro.js
// One-off diagnostic: shows what BetBoro's upcoming-events API returns so we can write the real parser.
//
//   node scripts/probe-betboro.js
//   node scripts/probe-betboro.js --comp=403 --multi=403,84,526,333
//   node scripts/probe-betboro.js --file=data/betboro-probe-403.json   (analyse a saved file offline)
//
// It saves the raw responses to data/betboro-probe-*.json. Upload those files + paste the console output.

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

const COMP = opt('comp', '403');
const MULTI = opt('multi', '403,84,526,333');
const FILE = opt('file', '');

const BASE = 'https://bs.betboro.com.gh/sport/1/upcoming-events';
const HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en',
  'api-language': 'en',
  authorization: 'Bearer null',
  origin: 'https://betboro.com.gh',
  referer: 'https://betboro.com.gh/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  'x-requested-with': 'XMLHttpRequest',
};

async function get(competitionIds) {
  const url = `${BASE}?sport_id=1&competition_ids=${competitionIds}&utc_offset=%2B00:00&pre_only=0`;
  const res = await fetch(url, { headers: HEADERS });
  const text = await res.text();
  return { url, status: res.status, text };
}

// Compact picture of the JSON structure
function shape(node, depth = 0, maxDepth = 4, indent = '') {
  const lines = [];
  if (Array.isArray(node)) {
    lines.push(`${indent}[array, ${node.length} items]`);
    if (node.length && depth < maxDepth) lines.push(...shape(node[0], depth + 1, maxDepth, indent + '  '));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (Array.isArray(v)) {
        lines.push(`${indent}${k}: [array, ${v.length}]`);
        if (v.length && depth < maxDepth) lines.push(...shape(v[0], depth + 1, maxDepth, indent + '    '));
      } else if (v && typeof v === 'object') {
        lines.push(`${indent}${k}: {object}`);
        if (depth < maxDepth) lines.push(...shape(v, depth + 1, maxDepth, indent + '    '));
      } else {
        const s = String(v);
        lines.push(`${indent}${k}: ${typeof v} = ${s.length > 40 ? s.slice(0, 40) + '…' : s}`);
      }
    }
  }
  return lines;
}

// Find the first array of objects that looks like a list of matches
function findEventArray(node, p = '$', depth = 0) {
  if (depth > 7) return null;
  if (Array.isArray(node)) {
    if (node.length && node.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
      const keys = Object.keys(node[0]).join(' ').toLowerCase();
      if (/home|away|team|competitor|participant|opponent/.test(keys)) return { path: p, arr: node };
    }
    for (let i = 0; i < Math.min(node.length, 3); i++) {
      const r = findEventArray(node[i], `${p}[${i}]`, depth + 1);
      if (r) return r;
    }
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const r = findEventArray(v, `${p}.${k}`, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function analyse(label, text) {
  console.log(`\n==================== ${label} ====================`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.log('Response is not JSON. First 300 chars:\n' + text.slice(0, 300));
    return null;
  }

  console.log('--- Structure (first item of each list) ---');
  console.log(shape(json).slice(0, 70).join('\n'));

  const found = findEventArray(json);
  if (found) {
    console.log(`\n--- Match list found at ${found.path}: ${found.arr.length} items ---`);
    console.log('Keys of first match: ' + Object.keys(found.arr[0]).join(', '));
    console.log('First match (trimmed):\n' + JSON.stringify(found.arr[0], null, 1).slice(0, 2500));
  } else {
    console.log('\nCould not auto-detect a list of matches. Upload the saved file instead.');
  }

  const srIds = new Set(text.match(/sr:match:\d+/g) ?? []);
  console.log(`\n--- Sportradar ids ("sr:match:...") in response: ${srIds.size} unique ${srIds.size ? '→ e.g. ' + [...srIds].slice(0, 3).join(', ') : ''}`);
  const idKeys = [...text.matchAll(/"(betradar[_a-z]*|sr_?id|external_?id|provider_?id|feed_?id|source_?id)"\s*:\s*("?[^,}\]]{1,40})/gi)].slice(0, 5);
  if (idKeys.length) console.log('Possible external-id fields: ' + idKeys.map((m) => `${m[1]}=${m[2]}`).join(' | '));

  const kw = {};
  for (const m of text.matchAll(/"(markets?|odds|outcomes?|selections?|bets?)"/gi)) {
    const k = m[1].toLowerCase();
    kw[k] = (kw[k] ?? 0) + 1;
  }
  console.log('Odds-related keys seen: ' + (JSON.stringify(kw) || 'none'));
  return { json, found };
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (FILE) {
    analyse(`FILE ${FILE}`, fs.readFileSync(FILE, 'utf8'));
    return;
  }

  const results = {};
  for (const [label, ids] of [[`single competition ${COMP}`, COMP], [`several competitions ${MULTI}`, MULTI]]) {
    try {
      const { url, status, text } = await get(ids);
      console.log(`\nGET ${url}\n→ HTTP ${status}, ${text.length} bytes`);
      const file = path.join(DATA_DIR, `betboro-probe-${ids.split(',').length === 1 ? ids : 'multi'}.json`);
      fs.writeFileSync(file, text);
      console.log(`Saved ${file}`);
      if (status >= 400) {
        console.log('Request was rejected. Body starts: ' + text.slice(0, 200));
        continue;
      }
      results[label] = analyse(label, text);
    } catch (e) {
      console.log(`Request failed for ${label}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  const counts = Object.entries(results).map(([k, v]) => `${k}: ${v?.found?.arr?.length ?? '?'} matches`);
  if (counts.length) console.log('\n--- Summary ---\n' + counts.join('\n'));
}

main();