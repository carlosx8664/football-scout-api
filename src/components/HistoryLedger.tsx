import { Fragment, useEffect, useMemo, useState } from "react";
import {
  fetchHistory,
  rangeForPreset,
  toDateInput,
  type HistoryPreset,
  type HistoryRange,
} from "../lib/history";
import { formatGhs } from "../lib/wallets";
import type { HistoryEntry, HistoryPayload } from "../types";
import "./HistoryLedger.css";

interface HistoryLedgerProps {
  simulation: boolean;
  /** Bumped after a settlement so the settled list and weekly outlay refetch. */
  refreshToken: number;
}

const PRESETS: Array<{ value: HistoryPreset; label: string }> = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "week", label: "This Week" },
  { value: "custom", label: "Custom" },
];

/** Calendar day key (UTC, matching the server's date() filter) for the group headers. */
const dayKey = (iso: string) => iso.slice(0, 10);

const dayLabel = (key: string) =>
  new Date(`${key}T00:00:00`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "short",
  });

const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

interface DayGroup {
  key: string;
  netProfit: number;
  entries: HistoryEntry[];
}

function groupByDay(entries: HistoryEntry[]): DayGroup[] {
  const groups: DayGroup[] = [];

  // The API returns newest first, so groups keep that order without a second sort.
  for (const entry of entries) {
    const key = dayKey(entry.settledAt);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, netProfit: 0, entries: [] };
      groups.push(group);
    }
    group.netProfit += entry.netProfit;
    group.entries.push(entry);
  }

  return groups;
}

/** Scrollable settled-arb ledger with a date filter, daily grouping and weekly outlay. */
const HistoryLedger = ({ simulation, refreshToken }: HistoryLedgerProps) => {
  const today = toDateInput(new Date());
  const [preset, setPreset] = useState<HistoryPreset>("week");
  const [custom, setCustom] = useState<HistoryRange>({ from: today, to: today });
  const [result, setResult] = useState<{ key: string; payload: HistoryPayload } | null>(null);
  const [problem, setProblem] = useState<{ key: string; message: string } | null>(null);

  const range = rangeForPreset(preset, custom);
  const key = `${simulation ? "sim" : "real"}|${range.from}|${range.to}`;

  useEffect(() => {
    const controller = new AbortController();

    fetchHistory(simulation, range, controller.signal)
      .then((next) => {
        setResult({ key, payload: next });
        setProblem(null);
      })
      .catch((err: Error) => {
        if (err.name === "AbortError") return;
        setProblem({ key, message: err.message });
      });

    return () => controller.abort();
  }, [simulation, range.from, range.to, refreshToken, key]);

  const payload = result?.key === key ? result.payload : null;
  const error = problem?.key === key ? problem.message : null;
  const loading = payload === null && error === null;
  const entries = payload?.entries ?? [];
  const groups = useMemo(() => groupByDay(entries), [entries]);
  /** Arb profit for the chosen window, to sit next to what the mug bets cost. */
  const arbProfit = entries.reduce((sum, entry) => sum + entry.netProfit, 0);

  return (
    <section className="history-panel">
      <header className="history-header">
        <div>
          <h2>History</h2>
          <p className="history-subtitle">
            Settled arbs from the {simulation ? "simulation" : "real"} ledger, grouped by day.
          </p>
        </div>
        <span className="history-badge">
          {entries.length} {entries.length === 1 ? "entry" : "entries"}
        </span>
      </header>

      <div className="history-toolbar">
        <div className="history-filters" role="tablist" aria-label="History date range">
          {PRESETS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={preset === option.value}
              className={`history-filter${preset === option.value ? " active" : ""}`}
              onClick={() => setPreset(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>

        {preset === "custom" && (
          <div className="history-custom">
            <input
              type="date"
              aria-label="From date"
              value={custom.from}
              max={custom.to}
              onChange={(event) => setCustom((current) => ({ ...current, from: event.target.value }))}
            />
            <span>→</span>
            <input
              type="date"
              aria-label="To date"
              value={custom.to}
              min={custom.from}
              onChange={(event) => setCustom((current) => ({ ...current, to: event.target.value }))}
            />
          </div>
        )}
      </div>

      {payload && (
        <div className="history-metrics">
          <div className="history-metric outlay" title="Stakes tied up now plus stakes settled this week">
            <span>Total Outlay This Week</span>
            <strong>{formatGhs(payload.totals.outlayThisWeek)}</strong>
            <span className="history-metric-hint">
              {formatGhs(payload.totals.activeOutlay)} active ·{" "}
              {formatGhs(payload.totals.historyOutlay)} settled
            </span>
          </div>
        </div>
      )}

      {error && <p className="history-error">{error}</p>}

      {loading ? (
        <p className="history-empty">Loading history…</p>
      ) : !payload ? null : groups.length === 0 ? (
        <p className="history-empty">No settled arbs in this range.</p>
      ) : (
        <div className="history-table-wrap">
          <table className="history-table">
            <thead>
              <tr>
                <th scope="col">Date Settled</th>
                <th scope="col">Event</th>
                <th scope="col">Bookie A</th>
                <th scope="col">Bookie B</th>
                <th scope="col">Total Stake</th>
                <th scope="col">Net Profit</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <Fragment key={group.key}>
                  <tr className="history-day-row">
                    <th scope="colgroup" colSpan={6}>
                      <span>{dayLabel(group.key)}</span>
                      <span
                        className={`history-day-total${group.netProfit < 0 ? " negative" : ""}`}
                      >
                        {group.netProfit >= 0 ? "+" : "−"}
                        {formatGhs(Math.abs(group.netProfit))}
                      </span>
                    </th>
                  </tr>
                  {group.entries.map((entry) => (
                    <tr key={entry.id}>
                      <td className="history-when">
                        <span>{timeLabel(entry.settledAt)}</span>
                        <span className="history-when-date">{dayLabel(group.key)}</span>
                      </td>
                      <td className="history-event">
                        {entry.eventName}
                        {entry.settlementType !== "win" && (
                          <span className="history-tag">
                            {entry.settlementType === "void"
                              ? "Void"
                              : entry.settlementType === "cashout"
                                ? "Cash Out"
                                : "Cancelled"}
                          </span>
                        )}
                      </td>
                      <td className="history-bookie">
                        {entry.bookieAName ?? "—"}
                        {entry.winningBookie !== null &&
                          entry.winningBookie === entry.bookieAName && (
                            <span className="history-won">won</span>
                          )}
                      </td>
                      <td className="history-bookie">
                        {entry.bookieBName ?? "—"}
                        {entry.winningBookie !== null &&
                          entry.winningBookie === entry.bookieBName && (
                            <span className="history-won">won</span>
                          )}
                      </td>
                      <td>{formatGhs(entry.totalStake)}</td>
                      <td
                        className={`history-profit${
                          entry.settlementType === "cancelled"
                            ? " muted"
                            : entry.settlementType !== "win"
                              ? " adhoc"
                              : ""
                        }${entry.netProfit < 0 ? " negative" : ""}`}
                      >
                        {entry.netProfit >= 0 ? "+" : "−"}
                        {formatGhs(Math.abs(entry.netProfit))}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {payload && payload.mugTotals.count > 0 && (
        <div className="history-mug">
          <header className="history-mug-header">
            <h3>Mug bets vs arb profit</h3>
            <span className="history-mug-hint">what the habit costs, in the same window</span>
          </header>

          <div className="history-mug-metrics">
            <div className="history-mug-metric">
              <span>Arb profit</span>
              <strong className={arbProfit < 0 ? "negative" : "positive"}>
                {formatGhs(arbProfit)}
              </strong>
            </div>
            <div className="history-mug-metric">
              <span>Mug staked</span>
              <strong>{formatGhs(payload.mugTotals.staked)}</strong>
            </div>
            <div className="history-mug-metric">
              <span>Mug returned</span>
              <strong>{formatGhs(payload.mugTotals.returned)}</strong>
            </div>
            <div className="history-mug-metric">
              <span>Net mug cost</span>
              <strong className={payload.mugTotals.net > 0 ? "negative" : "positive"}>
                {formatGhs(payload.mugTotals.net)}
              </strong>
            </div>
          </div>

          <ul className="history-mug-list">
            {payload.mugBets.slice(0, 8).map((bet) => (
              <li key={bet.id}>
                <span className="history-mug-bookie">{bet.bookie}</span>
                <span className="history-mug-event">{bet.eventName}</span>
                <span className={`history-mug-status ${bet.status}`}>
                  {bet.status === "open"
                    ? "open"
                    : bet.status === "won"
                      ? `won ${formatGhs(bet.payout)}`
                      : `lost ${formatGhs(bet.stake)}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
};

export default HistoryLedger;
