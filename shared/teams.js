/**
 * Team-name normalisation shared by the arbitrage scanner and the bet-builder matcher.
 * Stays dependency-free so Node scripts and the Vite bundle can both import it.
 *
 * Strips club suffixes/prefixes (FC, SC, United, City, Women...), lowercases and drops
 * every non-alphanumeric character, so "Man Utd" and "Manchester United" both collapse
 * to something comparable.
 *
 * @param {string | null | undefined} name
 * @returns {string}
 */
export function normalizeTeam(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/\b(fc|sc|afc|cf|united|utd|city|club|women|wom|wfc|lfc)\b/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}
