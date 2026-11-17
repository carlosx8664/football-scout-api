#!/usr/bin/env node
/**
 * Phase 1 vision spike for the bet-builder.
 *
 * Reads a betslip screenshot, asks a free-tier vision model to transcribe it into a strict JSON
 * list of legs, and prints the raw result so field accuracy can be judged before any matching
 * code exists. Read-only with respect to the app: no KV, no feed, no writing unless --out is given.
 *
 * Usage:
 *   node scripts/parse-betslip.js ./slip.png
 *   node scripts/parse-betslip.js ./slip.jpg --model=gemini-2.5-flash-lite
 *   node scripts/parse-betslip.js ./slip.png --out=data/betslip-spike.json
 *   node scripts/parse-betslip.js --dry-run ./slip.png      # prints the request, no API call
 *
 * Env (also read from .dev.vars):
 *   GEMINI_API_KEY      free tier at https://aistudio.google.com/apikey (preferred)
 *   OPENROUTER_API_KEY  optional fallback, see shared/vision.js
 *   VISION_PROVIDER     "gemini" | "openrouter"
 *   VISION_MODEL        overrides the primary provider's default model
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { LEG_SCHEMA, SYSTEM_PROMPT } from '../shared/betslip-prompt.js';
import { extractBetslipImage, isVisionConfigured, resolveVisionChain } from '../shared/vision.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const imageArg = argv.find((a) => !a.startsWith('--'));

/** Local convenience: pick up secrets from .dev.vars without overriding the real env. */
function loadDevVars() {
  const file = path.resolve(__dirname, '..', '.dev.vars');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, '');
  }
}

loadDevVars();

// `--model` wins over VISION_MODEL so a single run can compare two models.
const MODEL_OVERRIDE = opt('model', '');
if (MODEL_OVERRIDE) process.env.VISION_MODEL = MODEL_OVERRIDE;
const OUT_FILE = opt('out', '');
const DRY_RUN = flag('dry-run');
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// Prompt, schema and tolerant JSON parsing live in shared/betslip-prompt.js so the spike script
// and the /api/bet-builder/extract endpoint can never drift apart.

function printUsage() {
  console.log(`Usage: node scripts/parse-betslip.js <image> [options]

Options:
  --model=<name>    overrides VISION_MODEL for this run
  --out=<file>      also write the parsed JSON to a file
  --dry-run         print the request payload summary without calling the API

Environment:
  GEMINI_API_KEY      free tier at https://aistudio.google.com/apikey (preferred)
  OPENROUTER_API_KEY  optional fallback provider
  VISION_PROVIDER     "gemini" | "openrouter"
  VISION_MODEL        overrides the primary provider's default model`);
}

function readImage(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`Image not found: ${file}`);
  }

  const stats = fs.statSync(file);
  if (stats.size === 0) throw new Error(`Image is empty: ${file}`);
  if (stats.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image is ${(stats.size / 1024 / 1024).toFixed(1)} MB; the API limit is 20 MB.`);
  }

  const ext = path.extname(file).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    throw new Error(`Unsupported image type "${ext}". Use one of: ${Object.keys(MIME_BY_EXT).join(', ')}`);
  }

  return { bytes: fs.readFileSync(file), mime, size: stats.size };
}

const table = (value, width) => String(value ?? '—').slice(0, width).padEnd(width);

function printLegs(parsed) {
  const legs = Array.isArray(parsed?.legs) ? parsed.legs : [];
  if (legs.length === 0) {
    console.log('\nNo legs extracted.');
    return;
  }

  const header = `${table('#', 3)} ${table('teams', 42)} ${table('market', 22)} ${table('selection', 18)} odds`;
  console.log(`\n${header}`);
  console.log('-'.repeat(header.length));

  for (const leg of legs) {
    const teams = leg.home && leg.away ? `${leg.home} vs ${leg.away}` : '(no match header)';
    const odds = Number.isFinite(leg.odds) ? Number(leg.odds).toFixed(2) : '—';
    console.log(
      `${table(leg.rowIndex, 3)} ${table(teams, 42)} ${table(leg.market, 22)} ${table(leg.selection, 18)} ${odds}`,
    );
  }
}

async function callModel(image) {
  return extractBetslipImage({
    env: process.env,
    bytes: new Uint8Array(image.bytes),
    mime: image.mime,
  });
}

async function main() {
  if (!imageArg) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const image = readImage(imageArg);
  const [primary] = resolveVisionChain(process.env);
  console.log(`image : ${imageArg} (${(image.size / 1024).toFixed(0)} KB, ${image.mime})`);
  console.log(`model : ${primary ? `${primary.name}/${primary.model}` : 'not configured'}`);

  if (DRY_RUN) {
    console.log(`\nSchema:\n${JSON.stringify(LEG_SCHEMA, null, 2)}`);
    console.log(`\nSystem prompt:\n${SYSTEM_PROMPT}`);
    console.log(`\nDry run only — no API call made. Image payload: ${image.size} bytes.`);
    return;
  }

  if (!isVisionConfigured(process.env)) {
    throw new Error('No vision provider key is set. Add GEMINI_API_KEY to .dev.vars (free tier).');
  }

  const startedAt = Date.now();
  const result = await callModel(image);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const usage = result.usage ?? {};

  console.log(`latency: ${elapsed} s`);
  console.log(`provider: ${result.provider}/${result.model}`);
  console.log(
    `tokens : ${usage.promptTokenCount ?? usage.prompt_tokens ?? '?'} in / ` +
      `${usage.candidatesTokenCount ?? usage.completion_tokens ?? '?'} out`,
  );

  const parsed = result.parsed;

  console.log(`legs   : ${Array.isArray(parsed?.legs) ? parsed.legs.length : 0}`);
  if (parsed?.bookmaker) console.log(`book   : ${parsed.bookmaker}`);
  if (Array.isArray(parsed?.warnings) && parsed.warnings.length) {
    console.log('warnings:');
    for (const warning of parsed.warnings) console.log(`  ! ${warning}`);
  }

  console.log('\nRaw JSON:\n');
  console.log(JSON.stringify(parsed, null, 2));

  printLegs(parsed);

  if (OUT_FILE) {
    const target = path.resolve(process.cwd(), OUT_FILE);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(parsed, null, 2));
    console.log(`\nWrote ${target}`);
  }
}

main().catch((error) => {
  console.error(`\nFailed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
