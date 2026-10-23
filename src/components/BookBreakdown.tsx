import type { BookPrice } from "../types";
import { sortedQuotes } from "../lib/odds";

interface BookBreakdownProps {
  price?: BookPrice | null;
}

/**
 * Per-bookmaker prices shown on odds hover. The tile itself always keeps the best price,
 * so this only exposes where that price came from. Renders however many books quote the
 * outcome, best price first.
 */
const BookBreakdown = ({ price }: BookBreakdownProps) => {
  const rows = sortedQuotes(price);
  if (rows.length === 0) return null;

  return (
    <span className="book-tooltip" role="tooltip">
      {rows.map(([bookmaker, odds]) => (
        <span
          key={bookmaker}
          className={`book-tooltip-row${odds === price?.best ? " best" : ""}`}
        >
          <span>{bookmaker}</span>
          <span>{odds.toFixed(2)}</span>
        </span>
      ))}
    </span>
  );
};

export default BookBreakdown;
