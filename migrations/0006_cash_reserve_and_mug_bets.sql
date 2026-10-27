-- Unallocated cash (the mobile-money wallet) and the mug-bet tracker.
--
-- cash_reserve holds one row per mode: the part of the bankroll that is not sitting in a bookie
-- account. "Start afresh" seeds it with the leftover from rounding each wallet's opening deposit
-- down to 50 GHS (10,000 across 6 bookies -> 1,650 each + 100 left over), and "Withdraw weekly
-- profits" adds whatever it pulls out of the bookies.

CREATE TABLE IF NOT EXISTS cash_reserve (
  is_simulation INTEGER PRIMARY KEY CHECK (is_simulation IN (0, 1)),
  balance REAL NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO cash_reserve (is_simulation, balance) VALUES (1, 0), (0, 0);

-- Mug bets keep bookmaker accounts looking human: small singles on real matches. Kept in their
-- own table rather than `history` so arb profit stays a pure measure of the arbitrage book —
-- History reports the two side by side instead of merging them.
CREATE TABLE IF NOT EXISTS mug_bets (
  id TEXT PRIMARY KEY,
  bookie_name TEXT NOT NULL,
  event_name TEXT NOT NULL,
  stake REAL NOT NULL CHECK (stake > 0),
  odds REAL NOT NULL CHECK (odds > 1),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),
  payout REAL NOT NULL DEFAULT 0 CHECK (payout >= 0),
  is_simulation INTEGER NOT NULL DEFAULT 0 CHECK (is_simulation IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  settled_at TEXT
);

CREATE INDEX IF NOT EXISTS mug_bets_mode_idx
  ON mug_bets (is_simulation, created_at DESC);
