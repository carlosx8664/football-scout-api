PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(1,'0001_wallets_and_active_bets.sql','2026-10-26 13:58:32');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(2,'0002_history_details.sql','2026-10-26 23:59:09');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(3,'0003_history_settlement_type.sql','2026-10-26 23:59:09');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(4,'0004_wallet_transfers.sql','2026-10-27 12:30:42');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(5,'0005_active_bets_kickoff.sql','2026-10-27 14:33:26');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(6,'0006_cash_reserve_and_mug_bets.sql','2026-10-27 15:43:22');
CREATE TABLE wallets (
  id TEXT PRIMARY KEY,
  bookie_name TEXT NOT NULL,
  balance REAL NOT NULL DEFAULT 0 CHECK (balance >= 0),
  is_simulation INTEGER NOT NULL DEFAULT 0 CHECK (is_simulation IN (0, 1))
);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('sim-sportybet','SportyBet',1465,1);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('sim-msport','MSport',1650,1);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('sim-betboro','BetBoro',1650,1);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('sim-boltbet','BoltBet',805,1);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('real-sportybet','SportyBet',0,0);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('real-msport','MSport',0,0);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('real-betboro','BetBoro',0,0);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('real-boltbet','BoltBet',0,0);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('sim-betpawa','BetPawa',1650,1);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('sim-soccabet','Soccabet',1650,1);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('real-betpawa','BetPawa',0,0);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('real-soccabet','Soccabet',0,0);
CREATE TABLE active_bets (
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
, kickoff INTEGER);
INSERT INTO "active_bets" ("id","event_name","bookie_a_name","bookie_a_odds","bookie_a_stake","bookie_b_name","bookie_b_odds","bookie_b_stake","profit_percent","is_simulation","created_at","kickoff") VALUES('ea1eebd6-2326-43c9-8f4c-8604c87ec510','Newcastle United U21 vs Peterborough United U21 — Away Win vs Home/Draw (1X)','SportyBet',6,170,'BoltBet',1.23,830,2,1,'2026-10-29T17:22:05.386Z',1793386800000);
CREATE TABLE history (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  winning_bookie TEXT,
  net_profit REAL NOT NULL DEFAULT 0,
  is_simulation INTEGER NOT NULL DEFAULT 0 CHECK (is_simulation IN (0, 1)),
  settled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
, bookie_a_name TEXT, bookie_a_stake REAL, bookie_b_name TEXT, bookie_b_stake REAL, total_stake REAL, settlement_type TEXT NOT NULL DEFAULT 'win');
CREATE TABLE wallet_transfers (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
  bookie_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('deposit', 'withdrawal')),
  amount REAL NOT NULL CHECK (amount > 0),
  is_simulation INTEGER NOT NULL DEFAULT 0 CHECK (is_simulation IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE cash_reserve (
  is_simulation INTEGER PRIMARY KEY CHECK (is_simulation IN (0, 1)),
  balance REAL NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO "cash_reserve" ("is_simulation","balance","updated_at") VALUES(0,0,'2026-10-27T15:43:22.140Z');
INSERT INTO "cash_reserve" ("is_simulation","balance","updated_at") VALUES(1,100,'2026-10-29T17:21:51.490Z');
CREATE TABLE mug_bets (
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
INSERT INTO "mug_bets" ("id","bookie_name","event_name","stake","odds","status","payout","is_simulation","created_at","settled_at") VALUES('118ab8ad-e9cc-42b8-99e2-1f7f3b9ca114','BoltBet','Muggy',15,10,'open',0,1,'2026-10-29T17:22:34.270Z',NULL);
INSERT INTO "mug_bets" ("id","bookie_name","event_name","stake","odds","status","payout","is_simulation","created_at","settled_at") VALUES('14bab8d9-c600-4e6c-86df-30b2a6834c0d','SportyBet','Muggy',15,10,'open',0,1,'2026-10-29T17:22:41.412Z',NULL);
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('d1_migrations',6);
CREATE UNIQUE INDEX wallets_bookie_mode_idx
  ON wallets (bookie_name, is_simulation);
CREATE INDEX active_bets_mode_idx
  ON active_bets (is_simulation, created_at DESC);
CREATE INDEX history_mode_idx
  ON history (is_simulation, settled_at DESC);
CREATE INDEX wallet_transfers_mode_idx
  ON wallet_transfers (is_simulation, created_at DESC);
CREATE INDEX wallet_transfers_bookie_idx
  ON wallet_transfers (is_simulation, bookie_name, created_at DESC);
CREATE INDEX mug_bets_mode_idx
  ON mug_bets (is_simulation, created_at DESC);
