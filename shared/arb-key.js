/**
 * Stable identity for an arbitrage opportunity, shared by the scanner
 * (`scripts/find-arbs.js`), the push sender (`scripts/push-notify.js`) and the
 * arbs page (`src/components/ArbsTable.tsx`).
 *
 * Deliberately ignores the legs: prices and best bookmakers change between runs,
 * and a notification must still land on the same card after the feed refreshes.
 * `eventId` is the Sportradar id, so it survives renames of the teams.
 *
 * Mirrors `historyKey` in scripts/find-arbs.js.
 *
 * @param {{
 *   eventId?: string | null,
 *   kickoff?: number | null,
 *   home?: string | null,
 *   away?: string | null,
 *   market?: string | null,
 * }} arb
 * @returns {string}
 */
export function arbDeepLinkKey(arb) {
  const base = arb?.eventId ?? `${arb?.kickoff ?? ''}-${arb?.home ?? ''}-${arb?.away ?? ''}`;
  return `${base}|${arb?.market ?? ''}`;
}
