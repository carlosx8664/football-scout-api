import type { BookPrice } from "../types";

const BOOKMAKERS = [
  { key: "sportybet", label: "SportyBet" },
  { key: "msport", label: "MSport" },
] as const;

interface BookBreakdownProps {
  price?: BookPrice | null;
}

/**
 * Per-bookmaker prices shown on odds hover. The tile itself always keeps the best price,
 * so this only exposes where that price came from.
 */
const BookBreakdown = ({ price }: BookBreakdownProps) => {
  if (!price) return null;

  const rows = BOOKMAKERS.filter(({ key }) => price[key] != null);
  if (rows.length === 0) return null;

  return (
    <span className="book-tooltip" role="tooltip">
      {rows.map(({ key, label }) => (
        <span
          key={key}
          className={`book-tooltip-row${price[key] === price.best ? " best" : ""}`}
        >
          <span>{label}</span>
          <span>{price[key]?.toFixed(2)}</span>
        </span>
      ))}
    </span>
  );
};

export default BookBreakdown;
