/**
 * The betslip extraction contract, shared by `scripts/parse-betslip.js` (the Phase 1 spike) and
 * `functions/api/bet-builder/extract.js` (the live endpoint), so the two can never drift apart.
 *
 * DeepSeek only accepts `response_format: { type: "json_object" }`, so the shape is spelled out
 * in the prompt rather than enforced by a JSON schema. `LEG_SCHEMA` documents that shape and is
 * what the server-side validator will be built from.
 *
 * Bump PROMPT_VERSION whenever the prompt or schema changes: it is part of the KV cache key, so
 * a bump invalidates extractions made with the old wording.
 */

export const PROMPT_VERSION = "v1";

export const USER_PROMPT = "Extract every selection from this betslip.";

/**
 * Reference contract for a parsed slip (documentation + future validation, not sent on the wire).
 */
export const LEG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["bookmaker", "legs", "warnings"],
  properties: {
    bookmaker: { type: ["string", "null"] },
    warnings: { type: "array", items: { type: "string" } },
    legs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "rowIndex",
          "rawText",
          "home",
          "away",
          "leagueHint",
          "kickoffHint",
          "market",
          "selection",
          "odds",
        ],
        properties: {
          rowIndex: { type: "integer" },
          rawText: { type: "string" },
          home: { type: ["string", "null"] },
          away: { type: ["string", "null"] },
          leagueHint: { type: ["string", "null"] },
          kickoffHint: { type: ["string", "null"] },
          market: { type: "string" },
          selection: { type: "string" },
          odds: { type: ["number", "null"] },
        },
      },
    },
  },
};

export const SYSTEM_PROMPT = [
  "You transcribe betslip screenshots into structured JSON. You are a camera, not an analyst.",
  "",
  "Rules:",
  "1. Emit exactly one entry per selection row, in reading order (top to bottom).",
  "2. Never invent, translate, correct or expand a team name. Copy what is printed, including",
  "   abbreviations and typos.",
  "3. Several selections can belong to the same match (same-game parlay / bet builder). Emit one",
  "   entry each; do not merge them.",
  "4. home/away are the two teams of the match that row belongs to, in the order printed. If the",
  "   match header is not visible for that row (cropped, scrolled off), set both to null — do not",
  "   guess from another row.",
  "5. rawText: verbatim text of the line(s) for that selection, keeping the printed order.",
  '6. market: the market label as printed ("1X2", "Over/Under 2.5", "Both Teams To Score").',
  '   selection: the pick as printed ("Home", "Draw", "Away", "Over 2.5", "Yes").',
  "7. odds: the decimal price shown for that selection, as a number (1.85). Use null if absent.",
  "   Ignore stake, returns and currency amounts.",
  "8. leagueHint / kickoffHint: league name and kickoff date or time if printed for that match,",
  "   otherwise null.",
  "9. bookmaker: only if the brand is clearly readable in the image, otherwise null.",
  "10. warnings: list anything that undermines accuracy (cropped rows, unreadable text, ambiguous",
  "    grouping). Empty array when the slip is clean.",
  "",
  "Output format — return exactly this JSON structure:",
  "{",
  '  "bookmaker": string | null,',
  '  "warnings": string[],',
  '  "legs": [',
  "    {",
  '      "rowIndex": integer,',
  '      "rawText": string,',
  '      "home": string | null,',
  '      "away": string | null,',
  '      "leagueHint": string | null,',
  '      "kickoffHint": string | null,',
  '      "market": string,',
  '      "selection": string,',
  '      "odds": number | null',
  "    }",
  "  ]",
  "}",
  "",
  "Every key above must be present on every leg; use null when a value is unknown. rowIndex starts",
  "at 0 and counts selection rows from the top of the slip.",
  'Return a valid JSON object with a top-level key "legs" containing an array of objects, and a "warnings" array. Do not include any markdown formatting, backticks, or other text outside the JSON.',
  "",
  "If the image is not a betslip, return zero legs and say so in warnings.",
].join("\n");

/**
 * `json_object` mode normally returns clean JSON, but tolerate a stray code fence or a sentence
 * of prose around it instead of throwing.
 *
 * @param {string | null | undefined} content
 * @returns {any | null}
 */
export function parseJsonContent(content) {
  const text = String(content ?? "").trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    // fall through to the tolerant paths below
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // fall through
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // fall through
    }
  }

  return null;
}
