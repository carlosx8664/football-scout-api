import { useCallback, useEffect, useRef, useState } from "react";
import { selectionSide } from "../../shared/betslip-match.js";
import { extractBetslip } from "../lib/betBuilder";
import type {
  BetBuilderResponse,
  Match,
  MatchedCandidate,
  MatchedLeg,
  UnresolvedLeg,
} from "../types";
import "./BetBuilder.css";

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

const LinkButtons = ({
  links,
  prices,
}: {
  links: MatchedLeg["links"];
  prices?: Record<string, number | null> | null;
}) => (
  <div className="bb-actions">
    <BookButton
      variant="brand"
      url={links.sportybet}
      label="SportyBet"
      price={prices?.SportyBet ?? null}
    />
    <BookButton
      variant="ghost"
      url={links.msport}
      label="MSport"
      price={prices?.MSport ?? null}
    />
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

const ReviewCard = ({ entry }: { entry: UnresolvedLeg }) => (
  <article className="bb-card bb-card-review">
    <div className="bb-card-main">
      <div className="bb-card-teams">
        {entry.leg.home && entry.leg.away
          ? `${entry.leg.home} vs ${entry.leg.away}`
          : (entry.leg.rawText ?? "Unreadable match")}
      </div>
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

const BetBuilder = () => {
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<BetBuilderResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

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

      if (!file.type.startsWith("image/")) {
        setError("That file is not an image. Drop a PNG or JPEG screenshot of your betslip.");
        return;
      }

      showPreview(file);
      setError(null);
      setResult(null);
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
    if (inputRef.current) inputRef.current.value = "";
  };

  const scanning = phase === "scanning";
  const matched = result?.matched ?? [];
  const unresolved = result?.unresolved ?? [];
  const warnings = result?.warnings ?? [];

  return (
    <section className="bb-view">
      <h1 className="bb-title">Bet Builder</h1>
      <p className="bb-subtitle">
        Drop a betslip screenshot and we&apos;ll find every match in today&apos;s feed, with a
        direct link to the fixture on SportyBet and MSport.
      </p>

      <input
        ref={inputRef}
        className="bb-input"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(event) => void handleFile(event.target.files?.[0])}
      />

      <div
        className={`bb-drop${dragging ? " dragging" : ""}${scanning ? " busy" : ""}`}
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
              {preview ? "Scan another slip" : "Drop, paste or click to upload"}
            </strong>
            <span className="bb-drop-hint">PNG, JPEG, WebP or GIF · max 8 MB</span>
          </>
        )}
      </div>

      {error && (
        <div className="bb-error" role="alert">
          <strong>Couldn&apos;t read that slip.</strong>
          <span>{error}</span>
        </div>
      )}

      {phase === "done" && (
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
      )}
    </section>
  );
};

export default BetBuilder;
