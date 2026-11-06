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
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('sim-sportybet','SportyBet',4427.7,1);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('sim-msport','MSport',0,1);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('sim-betboro','BetBoro',2161.8,1);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('sim-boltbet','BoltBet',2762,1);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('real-sportybet','SportyBet',250,0);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('real-msport','MSport',0,0);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('real-betboro','BetBoro',250,0);
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
INSERT INTO "active_bets" ("id","event_name","bookie_a_name","bookie_a_odds","bookie_a_stake","bookie_b_name","bookie_b_odds","bookie_b_stake","profit_percent","is_simulation","created_at","kickoff","kind","is_free_bet","bookie_a_selection","bookie_b_selection","sr_event_id") VALUES('7932f076-7ded-438b-8e8b-fbda28dcc642','Charlton Athletic vs Sheffield United — Over/Under 3.5 Bookings','BetBoro',1.63,645,'SportyBet',2.95,355,4.72,1,'2026-11-05T17:26:57.568Z',1794063600000,'arb',0,'Over 3.5 Bookings','Under 3.5 Bookings','sr:match:72340016');
CREATE TABLE history (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  winning_bookie TEXT,
  net_profit REAL NOT NULL DEFAULT 0,
  is_simulation INTEGER NOT NULL DEFAULT 0 CHECK (is_simulation IN (0, 1)),
  settled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
, bookie_a_name TEXT, bookie_a_stake REAL, bookie_b_name TEXT, bookie_b_stake REAL, total_stake REAL, settlement_type TEXT NOT NULL DEFAULT 'win', kind TEXT, is_free_bet INTEGER NOT NULL DEFAULT 0 CHECK (is_free_bet IN (0, 1)), logged_at TEXT, kickoff INTEGER);
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff") VALUES('6d5e1119-bd16-4cf8-a307-900483eddb03','FC Porto vs SSC Napoli U20 — Home Win vs Draw/Away (X2)','BoltBet',72,1,'2026-11-05T18:54:36.145Z','BoltBet',1480,'BetBoro',520,2000,'win','arb',0,'2026-11-03T21:49:23.962Z',1793793600000);
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff") VALUES('04f4090b-810a-458c-9fcf-d3307de773f1','Muggy Acca - BoltBet',NULL,-30,1,'2026-11-05T18:54:43.100Z','BoltBet',30,'BoltBet',0,30,'loss','muggy',0,'2026-11-03T21:49:17.102Z',NULL);
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff") VALUES('40c24b02-54a1-49d7-ad0a-61240b33ea85','Muggy Acca - SportyBet',NULL,-30,1,'2026-11-05T18:54:59.602Z','SportyBet',30,'SportyBet',0,30,'loss','muggy',0,'2026-11-03T17:49:00.236Z',NULL);
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff") VALUES('25ac6c88-55e1-48a1-8934-975a16349539','Muggy Acca - BetBoro',NULL,-30,1,'2026-11-05T18:55:02.698Z','BetBoro',30,'BetBoro',0,30,'loss','muggy',0,'2026-11-03T17:49:06.085Z',NULL);
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff") VALUES('aa955243-e8ed-4bb0-8e59-b099b310710a','Muggy Acca - BetBoro',NULL,-30,1,'2026-11-05T18:55:17.632Z','BetBoro',30,'BetBoro',0,30,'loss','muggy',0,'2026-11-04T13:49:35.715Z',NULL);
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff") VALUES('e1f748a6-d6a3-4893-82d6-dc23d7da4f43','Muggy Acca - SportyBet',NULL,-30,1,'2026-11-05T18:55:27.833Z','SportyBet',30,'SportyBet',0,30,'loss','muggy',0,'2026-11-04T13:49:40.887Z',NULL);
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff") VALUES('851b4dfa-2b5c-47e4-8234-6cae960c7f14','Trabzonspor vs Freiburg — Over/Under 5.5 Bookings','BetBoro',116.8,1,'2026-11-05T20:09:57.856Z','SportyBet',740,'BetBoro',1260,2000,'win','arb',0,'2026-11-03T17:49:15.275Z',1793900700000);
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff") VALUES('3ce15928-bb72-466a-9d62-2974d10d4775','Mjallby AIF vs FK Borac Banja Luka — Over/Under 3.5 Bookings','SportyBet',116.5,1,'2026-11-05T20:10:18.742Z','BetBoro',1170,'SportyBet',830,2000,'win','arb',0,'2026-11-03T17:49:21.414Z',1793900700000);
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff") VALUES('1ac7e9f3-4fcb-4ebb-881c-46cf58018784','CSD Independiente del Valle vs Delfin SC — Home Win vs Draw/Away (X2)','SportyBet',56.2,1,'2026-11-06T02:31:18.345Z','SportyBet',1380,'BetBoro',620,2000,'win','arb',0,'2026-11-04T13:49:45.514Z',1793923200000);
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff") VALUES('381902e7-5849-4560-8897-d72942504e16','Muggy Acca - SportyBet',NULL,-30,1,'2026-11-06T02:31:40.363Z','SportyBet',30,'SportyBet',0,30,'loss','muggy',0,'2026-11-05T17:26:47.619Z',NULL);
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff") VALUES('34cb8b25-915f-4647-bcb3-2dcc7eb298e3','Muggy Acca - BetBoro',NULL,-30,1,'2026-11-06T02:31:45.626Z','BetBoro',30,'BetBoro',0,30,'loss','muggy',0,'2026-11-05T17:26:40.106Z',NULL);
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
INSERT INTO "wallet_transfers" ("id","wallet_id","bookie_name","kind","amount","is_simulation","created_at") VALUES('7f3cac4d-664e-4164-b3a6-dadf0f6ab28d','sim-boltbet','BoltBet','withdrawal',600,1,'2026-11-04T15:53:10.300Z');
INSERT INTO "wallet_transfers" ("id","wallet_id","bookie_name","kind","amount","is_simulation","created_at") VALUES('ff1a2584-bb7c-4da9-9e8c-082b07c61901','sim-betboro','BetBoro','deposit',350,1,'2026-11-05T14:36:14.629Z');
INSERT INTO "wallet_transfers" ("id","wallet_id","bookie_name","kind","amount","is_simulation","created_at") VALUES('bebcbb31-0f9f-4d71-bfac-d74a35a56a31','sim-sportybet','SportyBet','deposit',350,1,'2026-11-05T14:36:18.948Z');
INSERT INTO "wallet_transfers" ("id","wallet_id","bookie_name","kind","amount","is_simulation","created_at") VALUES('a6a8ab3c-671c-4cf4-86fe-fd8cc6dafafa','sim-betboro','BetBoro','deposit',100,1,'2026-11-05T17:13:43.408Z');
INSERT INTO "wallet_transfers" ("id","wallet_id","bookie_name","kind","amount","is_simulation","created_at") VALUES('62abee67-02ae-4f09-ab00-fca739b92703','sim-betboro','BetBoro','deposit',100,1,'2026-11-05T17:13:53.369Z');
INSERT INTO "wallet_transfers" ("id","wallet_id","bookie_name","kind","amount","is_simulation","created_at") VALUES('1fca7bee-1292-49fc-8785-97246b454e8a','sim-betboro','BetBoro','withdrawal',100,1,'2026-11-05T17:14:01.066Z');
INSERT INTO "wallet_transfers" ("id","wallet_id","bookie_name","kind","amount","is_simulation","created_at") VALUES('f595ba0e-e213-4e92-8b73-a576da723422','sim-betboro','BetBoro','deposit',100,1,'2026-11-05T17:25:56.614Z');
INSERT INTO "wallet_transfers" ("id","wallet_id","bookie_name","kind","amount","is_simulation","created_at") VALUES('3c81e6e9-f5f0-432e-9463-06b065699484','real-sportybet','SportyBet','deposit',250,0,'2026-11-06T13:43:36.090Z');
INSERT INTO "wallet_transfers" ("id","wallet_id","bookie_name","kind","amount","is_simulation","created_at") VALUES('62211def-e34f-490a-9a80-295b8febd104','real-betboro','BetBoro','deposit',250,0,'2026-11-06T13:43:36.090Z');
CREATE TABLE cash_reserve (
  is_simulation INTEGER PRIMARY KEY CHECK (is_simulation IN (0, 1)),
  balance REAL NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO "cash_reserve" ("is_simulation","balance","updated_at") VALUES(0,0,'2026-11-06T14:43:36.231Z');
INSERT INTO "cash_reserve" ("is_simulation","balance","updated_at") VALUES(1,0,'2026-11-05T17:25:56.648Z');
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
