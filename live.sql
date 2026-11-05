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
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(7,'0007_active_bets_kind.sql','2026-10-30 17:26:02');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(8,'0008_history_kind.sql','2026-10-30 17:26:03');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(9,'0009_free_bet_flag.sql','2026-10-30 17:26:03');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(10,'0010_active_bets_selection.sql','2026-10-30 17:39:36');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(11,'0011_history_logged_at.sql','2026-10-31 14:33:20');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(12,'0012_history_kickoff.sql','2026-11-02 15:51:29');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(13,'0013_active_bets_event_id.sql','2026-11-04 15:26:54');
CREATE TABLE wallets (
  id TEXT PRIMARY KEY,
  bookie_name TEXT NOT NULL,
  balance REAL NOT NULL DEFAULT 0 CHECK (balance >= 0),
  is_simulation INTEGER NOT NULL DEFAULT 0 CHECK (is_simulation IN (0, 1))
);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('sim-sportybet','SportyBet',290,1);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('sim-msport','MSport',0,1);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('sim-betboro','BetBoro',170,1);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('sim-boltbet','BoltBet',1290,1);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('real-sportybet','SportyBet',0,0);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('real-msport','MSport',0,0);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('real-betboro','BetBoro',0,0);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('real-boltbet','BoltBet',0,0);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('sim-betpawa','BetPawa',0,1);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('sim-soccabet','Soccabet',0,1);
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
, kickoff INTEGER, kind TEXT NOT NULL DEFAULT 'arb', is_free_bet INTEGER NOT NULL DEFAULT 0 CHECK (is_free_bet IN (0, 1)), bookie_a_selection TEXT, bookie_b_selection TEXT, sr_event_id TEXT);
INSERT INTO "active_bets" ("id","event_name","bookie_a_name","bookie_a_odds","bookie_a_stake","bookie_b_name","bookie_b_odds","bookie_b_stake","profit_percent","is_simulation","created_at","kickoff","kind","is_free_bet","bookie_a_selection","bookie_b_selection","sr_event_id") VALUES('66926a8f-f859-4245-9092-5208b66c6f2c','Muggy Acca - SportyBet','SportyBet',55,30,'SportyBet',1.01,0,0,1,'2026-11-03T17:49:00.236Z',NULL,'muggy',0,NULL,NULL,NULL);
INSERT INTO "active_bets" ("id","event_name","bookie_a_name","bookie_a_odds","bookie_a_stake","bookie_b_name","bookie_b_odds","bookie_b_stake","profit_percent","is_simulation","created_at","kickoff","kind","is_free_bet","bookie_a_selection","bookie_b_selection","sr_event_id") VALUES('8d753d84-e19d-4774-94eb-f66e4b995074','Muggy Acca - BetBoro','BetBoro',40,30,'BetBoro',1.01,0,0,1,'2026-11-03T17:49:06.085Z',NULL,'muggy',0,NULL,NULL,NULL);
INSERT INTO "active_bets" ("id","event_name","bookie_a_name","bookie_a_odds","bookie_a_stake","bookie_b_name","bookie_b_odds","bookie_b_stake","profit_percent","is_simulation","created_at","kickoff","kind","is_free_bet","bookie_a_selection","bookie_b_selection","sr_event_id") VALUES('0eb0a5ca-308e-49fc-b311-dc170e846446','Trabzonspor vs Freiburg — Over/Under 5.5 Bookings','SportyBet',2.85,740,'BetBoro',1.68,1260,5.45,1,'2026-11-03T17:49:15.275Z',1793900700000,'arb',0,'Over 5.5 Bookings','Under 5.5 Bookings',NULL);
INSERT INTO "active_bets" ("id","event_name","bookie_a_name","bookie_a_odds","bookie_a_stake","bookie_b_name","bookie_b_odds","bookie_b_stake","profit_percent","is_simulation","created_at","kickoff","kind","is_free_bet","bookie_a_selection","bookie_b_selection","sr_event_id") VALUES('7e3db84e-5511-4687-ab9f-41e29ea686b1','Mjallby AIF vs FK Borac Banja Luka — Over/Under 3.5 Bookings','BetBoro',1.82,1170,'SportyBet',2.55,830,5.83,1,'2026-11-03T17:49:21.414Z',1793900700000,'arb',0,'Over 3.5 Bookings','Under 3.5 Bookings',NULL);
INSERT INTO "active_bets" ("id","event_name","bookie_a_name","bookie_a_odds","bookie_a_stake","bookie_b_name","bookie_b_odds","bookie_b_stake","profit_percent","is_simulation","created_at","kickoff","kind","is_free_bet","bookie_a_selection","bookie_b_selection","sr_event_id") VALUES('d60b813f-9f17-418f-bf93-4ddada222ac1','Muggy Acca - BoltBet','BoltBet',7,30,'BoltBet',1.01,0,0,1,'2026-11-03T21:49:17.102Z',NULL,'muggy',0,NULL,NULL,NULL);
INSERT INTO "active_bets" ("id","event_name","bookie_a_name","bookie_a_odds","bookie_a_stake","bookie_b_name","bookie_b_odds","bookie_b_stake","profit_percent","is_simulation","created_at","kickoff","kind","is_free_bet","bookie_a_selection","bookie_b_selection","sr_event_id") VALUES('c612a2ca-811d-45b8-83eb-16202665580f','FC Porto vs SSC Napoli U20 — Home Win vs Draw/Away (X2)','BoltBet',1.4,1480,'BetBoro',4.03,520,3.6,1,'2026-11-03T21:49:23.962Z',1793793600000,'arb',0,'Home Win','Draw or Away (X2)',NULL);
INSERT INTO "active_bets" ("id","event_name","bookie_a_name","bookie_a_odds","bookie_a_stake","bookie_b_name","bookie_b_odds","bookie_b_stake","profit_percent","is_simulation","created_at","kickoff","kind","is_free_bet","bookie_a_selection","bookie_b_selection","sr_event_id") VALUES('bbdc3108-b1f2-4391-99c3-8a7ff599f0df','Muggy Acca - BetBoro','BetBoro',5,30,'BetBoro',1.01,0,0,1,'2026-11-04T13:49:35.715Z',NULL,'muggy',0,NULL,NULL,NULL);
INSERT INTO "active_bets" ("id","event_name","bookie_a_name","bookie_a_odds","bookie_a_stake","bookie_b_name","bookie_b_odds","bookie_b_stake","profit_percent","is_simulation","created_at","kickoff","kind","is_free_bet","bookie_a_selection","bookie_b_selection","sr_event_id") VALUES('2d6c447a-6b35-43f3-94fd-c4d855461c69','Muggy Acca - SportyBet','SportyBet',4.5,30,'SportyBet',1.01,0,0,1,'2026-11-04T13:49:40.887Z',NULL,'muggy',0,NULL,NULL,NULL);
INSERT INTO "active_bets" ("id","event_name","bookie_a_name","bookie_a_odds","bookie_a_stake","bookie_b_name","bookie_b_odds","bookie_b_stake","profit_percent","is_simulation","created_at","kickoff","kind","is_free_bet","bookie_a_selection","bookie_b_selection","sr_event_id") VALUES('21584a9c-1ecf-46cd-833e-a4fa28d5f53b','CSD Independiente del Valle vs Delfin SC — Home Win vs Draw/Away (X2)','SportyBet',1.49,1380,'BetBoro',3.31,620,2.61,1,'2026-11-04T13:49:45.514Z',1793923200000,'arb',0,'Home Win','Draw or Away (X2)',NULL);
CREATE TABLE history (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  winning_bookie TEXT,
  net_profit REAL NOT NULL DEFAULT 0,
  is_simulation INTEGER NOT NULL DEFAULT 0 CHECK (is_simulation IN (0, 1)),
  settled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
, bookie_a_name TEXT, bookie_a_stake REAL, bookie_b_name TEXT, bookie_b_stake REAL, total_stake REAL, settlement_type TEXT NOT NULL DEFAULT 'win', kind TEXT, is_free_bet INTEGER NOT NULL DEFAULT 0 CHECK (is_free_bet IN (0, 1)), logged_at TEXT, kickoff INTEGER);
CREATE TABLE wallet_transfers (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
  bookie_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('deposit', 'withdrawal')),
  amount REAL NOT NULL CHECK (amount > 0),
  is_simulation INTEGER NOT NULL DEFAULT 0 CHECK (is_simulation IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO "wallet_transfers" ("id","wallet_id","bookie_name","kind","amount","is_simulation","created_at") VALUES('3c5a6b43-10ea-49ae-a2df-757d89980d53','sim-sportybet','SportyBet','deposit',3300,1,'2026-11-03T14:21:45.447Z');
INSERT INTO "wallet_transfers" ("id","wallet_id","bookie_name","kind","amount","is_simulation","created_at") VALUES('0298dfbf-1dc3-4c80-9a72-f5e0aa289ec3','sim-betboro','BetBoro','deposit',3300,1,'2026-11-03T14:21:45.447Z');
INSERT INTO "wallet_transfers" ("id","wallet_id","bookie_name","kind","amount","is_simulation","created_at") VALUES('ebc14962-d581-4758-8812-2c6115320a4e','sim-boltbet','BoltBet','deposit',3300,1,'2026-11-03T14:21:45.447Z');
INSERT INTO "wallet_transfers" ("id","wallet_id","bookie_name","kind","amount","is_simulation","created_at") VALUES('bb7bd6e1-e798-46e1-a649-4f881887a553','sim-boltbet','BoltBet','withdrawal',500,1,'2026-11-04T13:49:05.946Z');
INSERT INTO "wallet_transfers" ("id","wallet_id","bookie_name","kind","amount","is_simulation","created_at") VALUES('a4235dea-c983-43a7-81ef-4a2632014f5f','sim-betboro','BetBoro','deposit',500,1,'2026-11-04T13:49:11.346Z');
CREATE TABLE cash_reserve (
  is_simulation INTEGER PRIMARY KEY CHECK (is_simulation IN (0, 1)),
  balance REAL NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO "cash_reserve" ("is_simulation","balance","updated_at") VALUES(0,0,'2026-10-27T15:43:22.140Z');
INSERT INTO "cash_reserve" ("is_simulation","balance","updated_at") VALUES(1,0,'2026-11-04T13:49:11.489Z');
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
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('d1_migrations',13);
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
CREATE INDEX active_bets_kind_idx ON active_bets (is_simulation, kind);
CREATE INDEX history_logged_at_idx ON history (is_simulation, kind, logged_at);
CREATE INDEX history_kickoff_idx ON history (is_simulation, kickoff);
CREATE INDEX active_bets_event_idx ON active_bets (sr_event_id);
