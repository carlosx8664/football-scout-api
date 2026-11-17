#!/usr/bin/env node
/**
 * Prints the model ids the configured vision keys can actually use.
 *
 * Free tiers rename and retire model ids without notice (`HTTP 404`), so this is the quickest
 * way to find the right `VISION_MODEL` after one disappears.
 *
 * Usage:
 *   node scripts/vision-models.js
 *   node scripts/vision-models.js --all      # every model, not just vision-looking ids
 *
 * Env (also read from .dev.vars): GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { probeModels, resolveVisionChain } from '../shared/vision.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const SHOW_ALL = argv.includes('--all');

const VISION_HINT = /-vl(?:[-:]|$)|vision|scout|maverick|gemma|multimodal|llava|pixtral|omni/i;

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

async function probeGemini(key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return { ids: [], ok: false, status: response.status, error: detail.slice(0, 200) };
    }
    const payload = await response.json().catch(() => null);
    const ids = (payload?.models ?? [])
      .filter((model) => (model?.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((model) => String(model?.name ?? '').replace(/^models\//, ''))
      .filter(Boolean)
      .sort();
    return { ids, ok: true, status: response.status, error: '' };
  } catch (error) {
    return { ids: [], ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

loadDevVars();

const chain = resolveVisionChain(process.env);
if (chain.length === 0) {
  console.log('No vision key found. Set GEMINI_API_KEY, GROQ_API_KEY or OPENROUTER_API_KEY.');
  process.exitCode = 1;
} else {
  for (const provider of chain) {
    const probe = provider.name === 'gemini' ? await probeGemini(provider.key) : await probeModels(provider);
    console.log(`\n${provider.name} — default "${provider.model}" (key ...${provider.key.slice(-4)})`);

    if (!probe.ok) {
      console.log(`  listing failed (HTTP ${probe.status || 'network'}): ${probe.error || 'no detail'}`);
      continue;
    }

    const shown = SHOW_ALL ? probe.ids : probe.ids.filter((id) => VISION_HINT.test(id) || id === provider.model);
    if (shown.length === 0) {
      console.log(`  ${probe.ids.length} models, none look vision-capable; pass --all to see them`);
    }
    for (const id of shown) console.log(`  ${id === provider.model ? '*' : ' '} ${id}`);
  }
}
