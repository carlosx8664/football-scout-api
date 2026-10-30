import { useCallback, useEffect, useRef, useState } from "react";
import { selectionSide } from "../../shared/betslip-match.js";
import { extractBetslip, createSportyBetSlip } from "../lib/betBuilder";
import type {
  BetBuilderResponse,
  Match,
  MatchedCandidate,
  MatchedLeg,
  UnresolvedLeg,
} from "../types";
import "./BetBuilder.css";

// AI features temporarily disabled (arbitrage-logic focus). Flip to true to re-enable.
const AI_FEATURES_ENABLED = false;

type Phase = "idle" | "scanning" | "done";

const REASON_LABEL: Record<UnresolvedLeg["reason"], string> = {
  "missing-teams": "Teams not readable",
  "no-candidates": "No fixture in the feed",
  "low-confidence": "Not confident enough",
  ambiguous: "More than one fixture fits",
};

const MAX_CANDIDATES = 3;
/** A drop this steep is worth warning about. */
const ODDS_WARN_PCT = 5;

function kickoffLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function openLink(url: string | null) {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

type ResultSide = NonNullable<ReturnType<typeof selectionSide>>;

function priceFor(match: Match, side: ResultSide, bookmaker: string): number | null {
  const price = match?.book_odds?.[side]?.books?.[bookmaker];
  return Number.isFinite(price) ? Number(price) : null;
}

/**
 * Compares the slip's price with the best price still on offer. Null means there is nothing to
 * say: no `book_odds` for this side, or the price moved less than 5% down and did not rise.
 */
function oddsMovement(original: number | null, prices: Record<string, number | null>) {
  if (!Number.isFinite(original) || Number(original) <= 0) return null;

  const available = Object.values(prices).filter(
    (price): price is number => Number.isFinite(price),
  );
  if (available.length === 0) return null;

  const best = Math.max(...available);
  const pct = ((best - Number(original)) / Number(original)) * 100;

  if (pct <= -ODDS_WARN_PCT) {
    return { tone: "down" as const, original: Number(original), best, pct };
  }
  if (pct > 0) {
    return { tone: "up" as const, original: Number(original), best, pct };
  }
  return null;
}

const BookButton = ({
  variant,
  url,
  label,
  price,
}: {
  variant: "brand" | "ghost";
  url: string | null;
  label: string;
  price: number | null;
}) => {
  // Tier 3 links are Google searches, so they get a magnifier instead of the external arrow.
  const isSearch = Boolean(url && url.includes("google.com/search"));

  return (
    <button
      type="button"
      className={`bb-btn bb-btn-${variant}`}
      onClick={() => openLink(url)}
      disabled={!url}
      title={isSearch ? `Search ${label} for this fixture` : `Open this fixture on ${label}`}
    >
      {label}
      {price !== null && <span className="bb-btn-price">@ {price.toFixed(2)}</span>}
      <span className={`bb-btn-icon${isSearch ? " search" : ""}`} aria-hidden="true">
        {isSearch ? "🔍" : "↗"}
      </span>
    </button>
  );
};

/** The local books we convert a slip to. Order is the display order everywhere. */
type BookKey = keyof MatchedLeg["links"];

const LOCAL_BOOKS: Array<{ key: BookKey; label: string; brand?: boolean }> = [
  { key: "sportybet", label: "SportyBet", brand: true },
  { key: "msport", label: "MSport" },
  { key: "betpawa", label: "BetPawa" },
  { key: "boltbet", label: "BoltBet" },
  { key: "betboro", label: "BetBoro" },
];

const LinkButtons = ({
  links,
  prices,
}: {
  links: MatchedLeg["links"];
  prices?: Record<string, number | null> | null;
}) => (
  <div className="bb-actions">
    {LOCAL_BOOKS.map(({ key, label, brand }) => (
      <BookButton
        key={key}
        variant={brand ? "brand" : "ghost"}
        url={links[key]}
        label={label}
        price={prices?.[label] ?? null}
      />
    ))}
  </div>
);

const MatchedRow = ({ entry }: { entry: MatchedLeg }) => {
  const { leg, match } = entry;

  // `book_odds` only carries 1X2 prices, so anything else gets the plain buttons.
  const side = selectionSide(leg, match);
  const prices = side
    ? {
        SportyBet: priceFor(match, side, "SportyBet"),
        MSport: priceFor(match, side, "MSport"),
      }
    : null;
  const movement = prices ? oddsMovement(leg.odds, prices) : null;

  return (
    <article className="bb-card">
      <div className="bb-card-main">
        <div className="bb-card-teams">
          {match.teams.home.name} <span className="bb-vs">vs</span> {match.teams.away.name}
        </div>
        <div className="bb-card-meta">
          {match.league?.name}
          {match.fixture?.date ? ` · ${kickoffLabel(match.fixture.date)}` : ""}
        </div>
        <div className="bb-card-selection">
          <span className="bb-market">{leg.market || "Market"}</span>
          <span className="bb-pick">{leg.selection}</span>
          {Number.isFinite(leg.odds) && (
            <span className="bb-odds">@ {Number(leg.odds).toFixed(2)}</span>
          )}
          {entry.flipped && <span className="bb-flag">Home/Away reversed</span>}
        </div>
      </div>

      <div className="bb-side">
        <LinkButtons links={entry.links} prices={prices} />
        {movement && (
          <span
            className={`bb-odds-badge ${movement.tone}`}
            title={`Slip ${movement.original.toFixed(2)} → best now ${movement.best.toFixed(2)}`}
          >
            {movement.tone === "down" ? "Odds dropped!" : "Odds boosted!"}{" "}
            {movement.pct > 0 ? "+" : ""}
            {movement.pct.toFixed(1)}%
          </span>
        )}
      </div>
    </article>
  );
};

/** Narrow sidebar row: teams, pick, and the link for the book currently selected. */
const CompactRow = ({
  entry,
  book,
  staged,
  onToggle,
}: {
  entry: MatchedLeg;
  book: BookKey;
  staged: boolean;
  onToggle: () => void;
}) => {
  const { leg, match } = entry;
  const label = LOCAL_BOOKS.find((item) => item.key === book)?.label ?? "";
  const url = entry.links[book];

  return (
    <div className="bb-compact-row">
      <div className="bb-compact-teams">
        <span>
          {match.teams.home.name} vs {match.teams.away.name}
        </span>
      </div>
      <div className="bb-compact-pick">
        <span className="bb-market">{leg.market || "Market"}</span>
        <span className="bb-pick">{leg.selection}</span>
        {Number.isFinite(leg.odds) && (
          <span className="bb-odds">@ {Number(leg.odds).toFixed(2)}</span>
        )}
      </div>
      <div className="bb-compact-meta">
        <span>{match.fixture?.date ? kickoffLabel(match.fixture.date) : ""}</span>
      </div>
      <div className="bb-compact-books">
        {url && (
          <button
            type="button"
            className="bb-compact-link"
            onClick={() => openLink(url)}
            title={`Open this fixture on ${label}`}
          >
            {label} ↗
          </button>
        )}
        {book === "sportybet" && entry.booking && (
          <button
            type="button"
            className={`bb-compact-add${staged ? " staged" : ""}`}
            onClick={onToggle}
            aria-pressed={staged}
          >
            {staged ? "In slip ✓" : "Add to Slip"}
          </button>
        )}
      </div>
    </div>
  );
};

const CandidateRow = ({ candidate }: { candidate: MatchedCandidate }) => (
  <div className="bb-candidate">
    <div className="bb-candidate-info">
      <span className="bb-candidate-teams">
        {candidate.match.teams.home.name} vs {candidate.match.teams.away.name}
      </span>
      <span className="bb-candidate-meta">
        {candidate.match.league?.name}
        {candidate.match.fixture?.date ? ` · ${kickoffLabel(candidate.match.fixture.date)}` : ""}
      </span>
    </div>
    <span className="bb-conf">{Math.round(candidate.confidence * 100)}% fit</span>
    <LinkButtons links={candidate.links} />
  </div>
);

/**
 * Needs Review legs are by definition unverified, and the model sometimes attaches a neighbouring
 * card's header to them. So the verbatim slip text is the headline; the model's reading is only
 * shown as a hint.
 */
function reviewHeadline(leg: UnresolvedLeg["leg"]): string {
  const raw = String(leg.rawText ?? "").replace(/\s+/g, " ").trim();
  if (raw) return raw.length > 120 ? `${raw.slice(0, 118)}..` : raw;
  if (leg.home && leg.away) return `${leg.home} vs ${leg.away}`;
  return "Unreadable match";
}

const ReviewCard = ({ entry }: { entry: UnresolvedLeg }) => {
  const raw = String(entry.leg.rawText ?? "").replace(/\s+/g, " ").trim();
  const guess =
    entry.leg.home && entry.leg.away ? `${entry.leg.home} vs ${entry.leg.away}` : null;

  return (
    <article className="bb-card bb-card-review">
      <div className="bb-card-main">
        <div className="bb-card-teams">{reviewHeadline(entry.leg)}</div>
        {guess && guess !== raw && (
          <span className="bb-card-guess">Model read: {guess}</span>
        )}
        <div className="bb-card-selection">
          <span className="bb-market">{entry.leg.market || "Market"}</span>
          <span className="bb-pick">{entry.leg.selection}</span>
          {Number.isFinite(entry.leg.odds) && (
            <span className="bb-odds">@ {Number(entry.leg.odds).toFixed(2)}</span>
          )}
        </div>
        <span className="bb-reason">{REASON_LABEL[entry.reason] ?? entry.reason}</span>

        {entry.candidates.length === 0 ? (
          <p className="bb-review-empty">
            Nothing in the feed looks close. Check that the match is on today's list.
          </p>
        ) : (
          <div className="bb-candidates">
            {entry.candidates.slice(0, MAX_CANDIDATES).map((candidate) => (
              <CandidateRow key={candidate.match.fixture.id} candidate={candidate} />
            ))}
          </div>
        )}
      </div>
    </article>
  );
};

interface BetBuilderProps {
  /** Sidebar-sized layout: no page heading, condensed results. */
  compact?: boolean;
}

const BetBuilder = ({ compact = false }: BetBuilderProps) => {
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<BetBuilderResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  /** Book the user is converting the slip to; only SportyBet can load a slip. */
  const [targetBook, setTargetBook] = useState<BookKey>("sportybet");
  /** rowIndexes of the legs staged for the SportyBet slip. */
  const [staged, setStaged] = useState<number[]>([]);
  const [slipBusy, setSlipBusy] = useState(false);
  const [slipError, setSlipError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const previewRef = useRef<string | null>(null);

  const showPreview = useCallback((file: File) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    const url = URL.createObjectURL(file);
    previewRef.current = url;
    setPreview(url);
  }, []);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );

  const handleFile = useCallback(
    async (file: File | null | undefined) => {
      if (!file) return;

      if (!AI_FEATURES_ENABLED) {
        setError("AI bet-slip extraction is temporarily disabled.");
        return;
      }

      if (!file.type.startsWith("image/")) {
        setError("That file is not an image. Drop a PNG or JPEG screenshot of your betslip.");
        return;
      }

      showPreview(file);
      setError(null);
      setResult(null);
      setStaged([]);
      setSlipError(null);
      setPhase("scanning");

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const payload = await extractBetslip(file, controller.signal);
        if (controller.signal.aborted) return;
        setResult(payload);
        setPhase("done");
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(
          caught instanceof Error
            ? caught.message
            : "Something went wrong while scanning that image.",
        );
        setPhase("idle");
      }
    },
    [showPreview],
  );

  // Pasting works anywhere on the page, which is how most people move a screenshot.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const items = Array.from(event.clipboardData?.items ?? []);
      const imageItem = items.find((item) => item.type.startsWith("image/"));
      const file = imageItem?.getAsFile();
      if (!file) return;
      event.preventDefault();
      void handleFile(file);
    };

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handleFile]);

  const reset = () => {
    abortRef.current?.abort();
    setPhase("idle");
    setResult(null);
    setError(null);
    setStaged([]);
    setSlipError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const toggleStaged = (rowIndex: number) => {
    setSlipError(null);
    setStaged((current) =>
      current.includes(rowIndex)
        ? current.filter((value) => value !== rowIndex)
        : [...current, rowIndex],
    );
  };

  const scanning = phase === "scanning";
  const matched = result?.matched ?? [];
  const unresolved = result?.unresolved ?? [];
  const warnings = result?.warnings ?? [];

  const stagedBookings = matched
    .filter((entry) => entry.booking && staged.includes(entry.leg.rowIndex))
    .map((entry) => entry.booking as NonNullable<MatchedLeg["booking"]>);

  const addStagedToSlip = async () => {
    if (stagedBookings.length === 0) return;
    setSlipBusy(true);
    setSlipError(null);
    try {
      openLink(await createSportyBetSlip(stagedBookings));
    } catch (caught) {
      setSlipError(
        caught instanceof Error ? caught.message : "Could not build the SportyBet slip.",
      );
    } finally {
      setSlipBusy(false);
    }
  };

  return (
    <section className={`bb-view${compact ? " bb-view-compact" : ""}`}>
      {compact ? (
        <div className="bb-head">
          <h3>🧾 Bet Builder</h3>
          <p className="bb-subtitle">
            Upload a betslip screenshot and convert its picks to your local book.
          </p>
        </div>
      ) : (
        <>
          <h1 className="bb-title">Bet Builder</h1>
          <p className="bb-subtitle">
            Drop a betslip screenshot and we&apos;ll find every match in today&apos;s feed, with a
            direct link to the fixture on SportyBet and MSport.
          </p>
        </>
      )}

      {AI_FEATURES_ENABLED ? (
        <>
      <input
        ref={inputRef}
        className="bb-input"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(event) => void handleFile(event.target.files?.[0])}
      />

      <div
        className={`bb-drop${compact ? " bb-drop-compact" : ""}${dragging ? " dragging" : ""}${scanning ? " busy" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") inputRef.current?.click();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void handleFile(event.dataTransfer.files?.[0]);
        }}
        onPaste={(event) => {
          const file = Array.from(event.clipboardData.items)
            .find((item) => item.type.startsWith("image/"))
            ?.getAsFile();
          if (!file) return;
          event.preventDefault();
          // Stop the window-level paste listener from handling the same event twice.
          event.stopPropagation();
          void handleFile(file);
        }}
      >
        {preview ? (
          <img className="bb-preview" src={preview} alt="Uploaded betslip" />
        ) : (
          <span className="bb-drop-icon" aria-hidden="true">
            ⬆
          </span>
        )}

        {scanning ? (
          <div className="bb-scanning" role="status">
            <span className="bb-spinner" aria-hidden="true" />
            <span>Scanning image… this takes about 5 seconds</span>
          </div>
        ) : (
          <>
            <strong className="bb-drop-title">
              {preview ? "Scan another slip" : compact ? "Drop, paste or click" : "Drop, paste or click to upload"}
            </strong>
            <span className="bb-drop-hint">
              {compact ? "PNG or JPEG · max 8 MB" : "PNG, JPEG, WebP or GIF · max 8 MB"}
            </span>
          </>
        )}
      </div>
        </>
      ) : (
        <div className="bb-error" role="alert">
          <strong>Bet Builder</strong>
          <span>AI bet-slip extraction is temporarily disabled.</span>
        </div>
      )}

      {error && (
        <div className="bb-error" role="alert">
          <strong>Couldn&apos;t read that slip.</strong>
          <span>{error}</span>
        </div>
      )}

      {phase === "done" && (compact ? (
        <div className="bb-compact">
          {warnings.length > 0 && (
            <div className="bb-warnings" role="status">
              <strong>The model flagged:</strong>
              <ul>
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="bb-book-picker" role="group" aria-label="Convert slip to">
            {LOCAL_BOOKS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                className={`bb-book-chip${targetBook === key ? " active" : ""}`}
                onClick={() => setTargetBook(key)}
                aria-pressed={targetBook === key}
              >
                {label}
              </button>
            ))}
          </div>

          {matched.length === 0 ? (
            <div className="bb-empty">No selections matched a fixture in the feed.</div>
          ) : (
            <div className="bb-compact-list">
              {matched.map((entry, index) => (
                <CompactRow
                  key={`${entry.match.fixture.id}-${entry.leg.rowIndex}-${index}`}
                  entry={entry}
                  book={targetBook}
                  staged={staged.includes(entry.leg.rowIndex)}
                  onToggle={() => toggleStaged(entry.leg.rowIndex)}
                />
              ))}
            </div>
          )}

          {targetBook === "sportybet" &&
            (stagedBookings.length > 0 ? (
              <button
                type="button"
                className="bb-btn bb-btn-brand bb-btn-compact"
                onClick={() => void addStagedToSlip()}
                disabled={slipBusy}
              >
                {slipBusy
                  ? "Building slip…"
                  : `Add ${stagedBookings.length} to SportyBet slip`}
                <span className="bb-btn-icon" aria-hidden="true">
                  ↗
                </span>
              </button>
            ) : (
              <button
                type="button"
                className="bb-btn bb-btn-brand bb-btn-compact"
                onClick={() => openLink(result?.sportybetAccaUrl ?? null)}
                disabled={!result?.sportybetAccaUrl}
              >
                Add {result?.stats?.bookable ?? matched.length} to SportyBet betslip
                <span className="bb-btn-icon" aria-hidden="true">
                  ↗
                </span>
              </button>
            ))}

          {slipError && (
            <span className="bb-acca-warn" role="alert">
              {slipError}
            </span>
          )}

          {result?.sportybetAccaWarning && (
            <span className="bb-acca-warn" role="status">
              {result.sportybetAccaWarning}
            </span>
          )}

          {unresolved.length > 0 && (
            <span className="bb-compact-note">
              {unresolved.length} selection{unresolved.length === 1 ? "" : "s"} need review
            </span>
          )}

          <div className="bb-compact-footer">
            <span>
              {result?.stats
                ? `${result.stats.matched} of ${result.stats.legs} legs matched`
                : `${matched.length} legs matched`}
            </span>
            <button type="button" className="bb-btn bb-btn-ghost bb-btn-compact" onClick={reset}>
              Scan another
            </button>
          </div>
        </div>
      ) : (
        <>
          {warnings.length > 0 && (
            <div className="bb-warnings" role="status">
              <strong>The model flagged:</strong>
              <ul>
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="bb-section">
            <div className="bb-section-head">
              <h2 className="bb-section-title">Matched</h2>
              <span className="bb-count">{matched.length}</span>
            </div>

            {matched.length > 0 && (
              <div className="bb-acca">
                <button
                  type="button"
                  className="bb-btn bb-btn-brand bb-btn-acca"
                  onClick={() => openLink(result?.sportybetAccaUrl ?? null)}
                  disabled={!result?.sportybetAccaUrl}
                >
                  Add all {result?.stats?.bookable ?? matched.length} to SportyBet betslip
                  <span className="bb-btn-icon" aria-hidden="true">↗</span>
                </button>
                {result?.sportybetAccaWarning && (
                  <span className="bb-acca-warn" role="status">
                    {result.sportybetAccaWarning}
                  </span>
                )}
              </div>
            )}

            {matched.length === 0 ? (
              <div className="bb-empty">No selections matched a fixture in the feed.</div>
            ) : (
              <div className="bb-list">
                {matched.map((entry, index) => (
                  <MatchedRow key={`${entry.match.fixture.id}-${entry.leg.rowIndex}-${index}`} entry={entry} />
                ))}
              </div>
            )}
          </div>

          {unresolved.length > 0 && (
            <div className="bb-section">
              <div className="bb-section-head">
                <h2 className="bb-section-title">Needs Review</h2>
                <span className="bb-count">{unresolved.length}</span>
              </div>
              <div className="bb-list">
                {unresolved.map((entry, index) => (
                  <ReviewCard key={`${entry.leg.rowIndex}-${index}`} entry={entry} />
                ))}
              </div>
            </div>
          )}

          <div className="bb-footer">
            <span>
              {result?.stats
                ? `${result.stats.matched} of ${result.stats.legs} legs matched`
                : `${matched.length} legs matched`}
              {result?.bookmaker ? ` · ${result.bookmaker}` : ""}
              {result?.cached ? " · cached scan" : ""}
            </span>
            <button type="button" className="bb-btn bb-btn-ghost" onClick={reset}>
              Scan another
            </button>
          </div>
        </>
      ))}
    </section>
  );
};

export default BetBuilder;
