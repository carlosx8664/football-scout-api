// scripts/debug-sportybet-markets.js
// Run this locally to discover the exact marketIds for deep markets (Shots, Half Goals, Team Totals)
// for a specific upcoming SportyBet event.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The Man Utd vs Bournemouth match from your cURL
const EVENT_ID = 'sr:match:72221348';
const EVENT_URL = `https://www.sportybet.com/api/gh/factsCenter/event?eventId=${encodeURIComponent(EVENT_ID)}&productId=3&_t=${Date.now()}`;

// The bulk feed URL to test the "Team Total" guess (marketId=227)
const BULK_URL = `https://www.sportybet.com/api/gh/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A1&marketId=227&pageSize=100&pageNum=1&timeline=48&_t=${Date.now()}`;

// Reusing the core headers from your fetch-odds.js
const HEADERS = {
  Accept: '*/*',
  'Accept-Language': 'en',
  Clientid: 'web',
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  Operid: '3',
  Platform: 'web',
  Referer: `https://www.sportybet.com/gh/sport/football/England/Premier_League/Man_Utd_vs_Bournemouth/${EVENT_ID}`,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0',
  // Note: We are skipping the browser cookies here. If SportyBet rejects the request,
  // you can paste the relevant cookie string here temporarily.
  Cookie: 'sb_country=gh; locale=en;',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Capture output for clipboard
let logBuffer = [];
const originalLog = console.log;
const originalError = console.error;

console.log = (...args) => {
  const msg = args.join(' ');
  logBuffer.push(msg);
  originalLog(...args);
};

console.error = (...args) => {
  const msg = args.join(' ');
  logBuffer.push(msg);
  originalError(...args);
};

function copyToClipboard() {
  const text = logBuffer.join('\n');
  try {
    // Use PowerShell to copy to clipboard on Windows
    execSync('powershell.exe -NoProfile -Command "$input | Set-Clipboard"', { input: text });
    originalLog('\n📋 Output copied to clipboard!');
  } catch (e) {
    originalLog('\n⚠️ Could not copy to clipboard. Are you on Windows?');
  }
}

async function fetchEvent() {
  console.log(`🚀 Fetching Event: ${EVENT_ID}...`);
  const res = await fetch(EVENT_URL, { method: 'GET', headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return await res.json();
}

async function fetchBulk() {
  console.log(`\n🚀 Fetching Bulk Feed (marketId=227)...`);
  const res = await fetch(BULK_URL, { method: 'GET', headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return await res.json();
}

function extractDeepMarkets(data) {
  // Navigate the SportyBet structure: data -> event -> markets
  const event = data?.data?.event || data?.data;
  if (!event) return [];

  const markets = event.markets || [];
  const matches = [];

  for (const m of markets) {
    const desc = (m.desc || m.name || '').toLowerCase();
    const id = String(m.id);

    // Filter for the markets we care about
    if (/(shot|target|half|period|team.*total|total.*team|corner|card)/i.test(desc)) {
      matches.push({
        id,
        desc: m.desc || m.name,
        specifier: m.specifier || 'none',
        outcomes: (m.outcomes || []).map((o) => o.desc || o.name).join(' | '),
      });
    }
  }

  return matches;
}

async function run() {
  const outputDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  try {
    // 1. Fetch and parse the single event
    const eventData = await fetchEvent();
    
    // Save raw dump
    const dumpPath = path.join(outputDir, 'debug-manutd-event.json');
    fs.writeFileSync(dumpPath, JSON.stringify(eventData, null, 2));
    console.log(`✅ Saved raw event JSON to ${dumpPath}`);

    // 2. Extract and print filtered markets
    const deepMarkets = extractDeepMarkets(eventData);
    
    console.log(`\n📊 Found ${deepMarkets.length} Deep Markets:`);
    console.log('='.repeat(80));
    for (const m of deepMarkets) {
      console.log(`ID: ${m.id.padEnd(5)} | Desc: ${(m.desc || 'N/A').padEnd(30)} | Specifier: ${m.specifier}`);
      console.log(`     Outcomes: ${m.outcomes}`);
      console.log('-'.repeat(80));
    }

    if (deepMarkets.length === 0) {
      console.log('⚠️ No deep markets matched the filter. Inspect the raw JSON dump to see what is actually there.');
    }

    await sleep(2000);

    // 3. Test the bulk feed guess
    try {
      const bulkData = await fetchBulk();
      const tournaments = bulkData.data?.tournaments || [];
      let eventCount = 0;
      for (const t of tournaments) {
        eventCount += (t.events || []).length;
      }
      console.log(`\n✅ Bulk Feed Test (marketId=227): Returned ${eventCount} events across ${tournaments.length} tournaments.`);
      if (eventCount === 0) {
        console.log('   ⚠️ marketId 227 might be invalid for the bulk feed, or there are no upcoming matches for it.');
      }
    } catch (e) {
      console.log(`\n❌ Bulk Feed Test failed: ${e.message}`);
    }

  } catch (e) {
    console.error(`\n❌ Fatal Error: ${e.message}`);
  } finally {
    copyToClipboard();
  }
}

run();