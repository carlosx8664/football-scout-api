-- Wallet Management + Simulation Mode.
--
-- Four bookmaker wallets per mode, both tagged with `is_simulation` so the global UI toggle can
-- switch the whole dashboard between simulated money (is_simulation = 1) and real money (0).
-- Simulation wallets are seeded at 250 GHS each = the 1,000 GHS reset target.

CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,
  bookie_name TEXT NOT NULL,
  balance REAL NOT NULL DEFAULT 0 CHECK (balance >= 0),
  is_simulation INTEGER NOT NULL DEFAULT 0 CHECK (is_simulation IN (0, 1))
);

-- One wallet per bookie per mode.
CREATE UNIQUE INDEX IF NOT EXISTS wallets_bookie_mode_idx
  ON wallets (bookie_name, is_simulation);

CREATE TABLE IF NOT EXISTS active_bets (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  bookie_a_name TEXT NOT NULL,
  bookie_a_odds REAL NOT NULL CHECK (bookie_a_odds > 0),
  bookie_a_stake REAL NOT NULL CHECK (bookie_a_stake >= 0),
  bookie_b_name TEXT NOT NULL,
  bookie_b_odds REAL NOT NULL CHECK (bookie_b_odds > 0),
  bookie_b_stake REAL NOT NULL CHECK (bookie_b_stake >= 0),
  profit_percent REAL NOT NULL DEFAULT 0,
  is_simulation INTEGER NOT NULL DEFAULT 0 CHECK (is_simulation IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Available liquidity = wallets - SUM(bookie_a_stake + bookie_b_stake) of active bets in the same mode.
CREATE INDEX IF NOT EXISTS active_bets_mode_idx
  ON active_bets (is_simulation, created_at DESC);

CREATE TABLE IF NOT EXISTS history (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  winning_bookie TEXT,
  net_profit REAL NOT NULL DEFAULT 0,
  is_simulation INTEGER NOT NULL DEFAULT 0 CHECK (is_simulation IN (0, 1)),
  settled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS history_mode_idx
  ON history (is_simulation, settled_at DESC);

INSERT OR IGNORE INTO wallets (id, bookie_name, balance, is_simulation) VALUES
  ('sim-sportybet', 'SportyBet', 250, 1),
  ('sim-msport',    'MSport',    250, 1),
  ('sim-betboro',   'BetBoro',   250, 1),
  ('sim-boltbet',   'BoltBet',   250, 1),
  ('real-sportybet', 'SportyBet', 0, 0),
  ('real-msport',    'MSport',    0, 0),
  ('real-betboro',   'BetBoro',   0, 0),
  ('real-boltbet',   'BoltBet',   0, 0);
