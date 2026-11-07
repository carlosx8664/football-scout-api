-- A profit take is money leaving the system, not a transfer between MOMO and a bookie, so the
-- cash-flow ledger needs a third type. SQLite cannot widen a CHECK constraint in place, so the
-- table is rebuilt and its rows copied across.
CREATE TABLE wallet_transfers_new (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
  bookie_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('deposit', 'withdrawal')),
  amount REAL NOT NULL CHECK (amount > 0),
  is_simulation INTEGER NOT NULL DEFAULT 0 CHECK (is_simulation IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  transfer_type TEXT NOT NULL DEFAULT 'BOOKIE_TRANSFER'
    CHECK (transfer_type IN ('BOOKIE_TRANSFER', 'CAPITAL_INJECTION', 'PROFIT_TAKE'))
);

INSERT INTO wallet_transfers_new
  (id, wallet_id, bookie_name, kind, amount, is_simulation, created_at, transfer_type)
SELECT id, wallet_id, bookie_name, kind, amount, is_simulation, created_at,
       COALESCE(transfer_type, 'BOOKIE_TRANSFER')
  FROM wallet_transfers;

DROP TABLE wallet_transfers;

ALTER TABLE wallet_transfers_new RENAME TO wallet_transfers;

CREATE INDEX IF NOT EXISTS wallet_transfers_mode_idx
  ON wallet_transfers (is_simulation, created_at DESC);

CREATE INDEX IF NOT EXISTS wallet_transfers_bookie_idx
  ON wallet_transfers (is_simulation, bookie_name, created_at DESC);
