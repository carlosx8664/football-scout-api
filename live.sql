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
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(14,'0014_capital_injections.sql','2026-11-07 14:18:12');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(15,'0015_bet_sport.sql','2026-11-07 15:43:38');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(16,'0016_profit_take.sql','2026-11-07 15:43:38');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(17,'0017_transfer_types.sql','2026-11-08 18:30:08');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(18,'0018_initial_deposit.sql','2026-11-08 18:30:09');
CREATE TABLE wallets (
  id TEXT PRIMARY KEY,
  bookie_name TEXT NOT NULL,
  balance REAL NOT NULL DEFAULT 0 CHECK (balance >= 0),
  is_simulation INTEGER NOT NULL DEFAULT 0 CHECK (is_simulation IN (0, 1))
);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('sim-sportybet','SportyBet',6647.5,1);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('sim-msport','MSport',0,1);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('sim-betboro','BetBoro',5307.5,1);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('sim-boltbet','BoltBet',0,1);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('real-sportybet','SportyBet',148.5,0);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('real-msport','MSport',0,0);
INSERT INTO "wallets" ("id","bookie_name","balance","is_simulation") VALUES('real-betboro','BetBoro',53.669999999999945,0);
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
, kickoff INTEGER, kind TEXT NOT NULL DEFAULT 'arb', is_free_bet INTEGER NOT NULL DEFAULT 0 CHECK (is_free_bet IN (0, 1)), bookie_a_selection TEXT, bookie_b_selection TEXT, sr_event_id TEXT, sport TEXT NOT NULL DEFAULT 'football'
  CHECK (sport IN ('football', 'horse-racing')));
INSERT INTO "active_bets" ("id","event_name","bookie_a_name","bookie_a_odds","bookie_a_stake","bookie_b_name","bookie_b_odds","bookie_b_stake","profit_percent","is_simulation","created_at","kickoff","kind","is_free_bet","bookie_a_selection","bookie_b_selection","sr_event_id","sport") VALUES('1b918bd0-af66-40ac-a466-e6c3d0edf145','Niger vs Morocco — Both Teams to Score','SportyBet',3.8,85,'BetBoro',1.44,215,3.2,0,'2026-11-14T13:34:27.013Z',1794945600000,'arb',0,'BTTS Yes','BTTS No','sr:match:75802230','football');
INSERT INTO "active_bets" ("id","event_name","bookie_a_name","bookie_a_odds","bookie_a_stake","bookie_b_name","bookie_b_odds","bookie_b_stake","profit_percent","is_simulation","created_at","kickoff","kind","is_free_bet","bookie_a_selection","bookie_b_selection","sr_event_id","sport") VALUES('52808ada-3877-47b5-8d8a-01a2c162b2dd','Niger vs Morocco — Both Teams to Score','SportyBet',3.8,830,'BetBoro',1.44,2170,4.16,1,'2026-11-14T13:48:22.044Z',1794945600000,'arb',0,'BTTS Yes','BTTS No','sr:match:75802230','football');
CREATE TABLE history (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  winning_bookie TEXT,
  net_profit REAL NOT NULL DEFAULT 0,
  is_simulation INTEGER NOT NULL DEFAULT 0 CHECK (is_simulation IN (0, 1)),
  settled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
, bookie_a_name TEXT, bookie_a_stake REAL, bookie_b_name TEXT, bookie_b_stake REAL, total_stake REAL, settlement_type TEXT NOT NULL DEFAULT 'win', kind TEXT, is_free_bet INTEGER NOT NULL DEFAULT 0 CHECK (is_free_bet IN (0, 1)), logged_at TEXT, kickoff INTEGER, sport TEXT NOT NULL DEFAULT 'football'
  CHECK (sport IN ('football', 'horse-racing')));
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff","sport") VALUES('dbf28bf3-e9e3-4dd6-b686-17632ca4ab8b','Muggy Acca - BetBoro','BetBoro',1.67,0,'2026-11-06T16:55:55.945Z','BetBoro',1.5,'BetBoro',0,1.5,'win','muggy',0,'2026-11-06T15:44:44.958Z',NULL,'football');
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff","sport") VALUES('8c84a408-ecfb-4a22-84ee-ec919e5d891d','Muggy Acca - BetBoro',NULL,-1.5,0,'2026-11-06T16:56:05.575Z','BetBoro',1.5,'BetBoro',0,1.5,'loss','muggy',0,'2026-11-06T15:44:30.865Z',NULL,'football');
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff","sport") VALUES('cfee956d-9ff0-4288-b7d5-c2f0cb8a024a','Muggy Acca - SportyBet',NULL,-3,0,'2026-11-06T22:01:25.537Z','SportyBet',3,'SportyBet',0,3,'loss','muggy',0,'2026-11-06T15:33:14.546Z',NULL,'football');
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff","sport") VALUES('7a6fa9ab-82af-4c5e-bb29-b6cbc3dc1829','Muggy Acca - SportyBet',NULL,-1.5,0,'2026-11-07T15:54:49.706Z','SportyBet',1.5,'SportyBet',0,1.5,'loss','muggy',0,'2026-11-07T09:16:18.976Z',NULL,'football');
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff","sport") VALUES('e042f8bd-689a-4148-a1ba-52a06d4d47a0','Muggy Acca - SportyBet',NULL,-1.5,0,'2026-11-07T15:54:59.965Z','SportyBet',1.5,'SportyBet',0,1.5,'loss','muggy',0,'2026-11-07T09:12:29.345Z',NULL,'football');
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff","sport") VALUES('693242e8-7676-42ca-8229-f8976a0772fc','Muggy Acca - BetBoro',NULL,-3,0,'2026-11-07T16:53:56.898Z','BetBoro',3,'BetBoro',0,3,'loss','muggy',0,'2026-11-07T07:09:25.783Z',NULL,'football');
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff","sport") VALUES('954f513b-9a49-460d-9085-3edea399ab43','Valencia vs Real Madrid — Over/Under 4.5 Bookings','SportyBet',12,0,'2026-11-07T22:59:51.607Z','SportyBet',80,'BetBoro',120,200,'win','arb',0,'2026-11-07T07:06:58.818Z',1794081600000,'football');
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff","sport") VALUES('f13bc4c8-00ec-450d-9410-c6219392c802','CF Montreal vs Vancouver Whitecaps FC — Over/Under 4.5 Bookings','SportyBet',20.5,0,'2026-11-07T23:04:15.161Z','SportyBet',90,'BetBoro',110,200,'win','arb',0,'2026-11-06T21:25:54.728Z',1794085200000,'football');
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff","sport") VALUES('b4dd9070-827a-4559-a571-5ef215560f6a','Muggy Acca - BetBoro',NULL,-3,0,'2026-11-08T18:35:59.370Z','BetBoro',3,'BetBoro',0,3,'loss','muggy',0,'2026-11-08T18:35:30.659Z',NULL,'football');
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff","sport") VALUES('505eb25f-55b4-4edf-901a-ff7c436b85dc','Muggy Acca - SportyBet',NULL,-3,0,'2026-11-08T18:36:08.674Z','SportyBet',3,'SportyBet',0,3,'loss','muggy',0,'2026-11-08T18:35:40.502Z',NULL,'football');
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff","sport") VALUES('775dcd8b-7688-47ac-8abc-49ce556bb0e4','Muggy Acca - BetBoro','BetBoro',9.2,0,'2026-11-09T06:17:06.315Z','BetBoro',10,'BetBoro',0,10,'win','muggy',0,'2026-11-08T18:35:19.332Z',NULL,'football');
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff","sport") VALUES('1aa335ed-252e-4960-8b05-f996bfcbdb91','Muggy Acca - SportyBet',NULL,-10,0,'2026-11-14T15:52:19.732Z','SportyBet',10,'SportyBet',0,10,'loss','muggy',0,'2026-11-14T12:08:59.818Z',NULL,'football');
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff","sport") VALUES('121a886a-e707-4a93-be65-34c0679641a2','Muggy Acca - SportyBet',NULL,-10,0,'2026-11-14T16:52:41.727Z','SportyBet',10,'SportyBet',0,10,'loss','muggy',0,'2026-11-14T11:47:28.430Z',NULL,'football');
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff","sport") VALUES('c32343fd-1ec8-46d7-a7a6-8afd6b7a7170','Muggy Acca - BetBoro',NULL,-3,0,'2026-11-15T00:16:34.427Z','BetBoro',3,'BetBoro',0,3,'loss','muggy',0,'2026-11-14T13:34:17.712Z',NULL,'football');
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff","sport") VALUES('f395925a-cb7d-4850-b1cd-9149fbdcd976','Muggy Acca - SportyBet',NULL,-22.5,1,'2026-11-15T11:34:24.542Z','SportyBet',22.5,'SportyBet',0,22.5,'loss','muggy',0,'2026-11-14T13:47:58.704Z',NULL,'football');
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff","sport") VALUES('60a3d299-e688-4396-a2c7-d1ba00539b22','Muggy Acca - BetBoro',NULL,-22.5,1,'2026-11-15T11:34:27.990Z','BetBoro',22.5,'BetBoro',0,22.5,'loss','muggy',0,'2026-11-14T13:47:52.723Z',NULL,'football');
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff","sport") VALUES('e81bf28e-6fd7-4de0-bbd9-2f2417d07706','Free bet - BetBoro','BetBoro',33.3,0,'2026-11-15T22:21:39.194Z','BetBoro',10,'SportyBet',0,0,'win','free',1,'2026-11-15T13:04:39.659Z',NULL,'football');
INSERT INTO "history" ("id","event_name","winning_bookie","net_profit","is_simulation","settled_at","bookie_a_name","bookie_a_stake","bookie_b_name","bookie_b_stake","total_stake","settlement_type","kind","is_free_bet","logged_at","kickoff","sport") VALUES('c2563322-a593-422e-9f81-c89d8b05e2af','Muggy Acca - BetBoro',NULL,-10,0,'2026-11-16T18:05:50.014Z','BetBoro',10,'BetBoro',0,10,'loss','muggy',0,'2026-11-16T13:20:27.336Z',NULL,'horse-racing');
CREATE TABLE cash_reserve (
  is_simulation INTEGER PRIMARY KEY CHECK (is_simulation IN (0, 1)),
  balance REAL NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO "cash_reserve" ("is_simulation","balance","updated_at") VALUES(0,0,'2026-11-08T18:34:28.682Z');
INSERT INTO "cash_reserve" ("is_simulation","balance","updated_at") VALUES(1,0,'2026-11-10T15:53:57.974Z');
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
CREATE TABLE IF NOT EXISTS "wallet_transfers" (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
  bookie_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('deposit', 'withdrawal')),
  amount REAL NOT NULL CHECK (amount > 0),
  is_simulation INTEGER NOT NULL DEFAULT 0 CHECK (is_simulation IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  transfer_type TEXT NOT NULL DEFAULT 'BOOKIE_TRANSFER'
    CHECK (transfer_type IN (
      'BOOKIE_TRANSFER',
      'CAPITAL_INJECTION',
      'PROFIT_WITHDRAWAL',
      'TRANSFER_TO_MOMO',
      'TRANSFER_TO_BOOKIE',
      'INITIAL_DEPOSIT'
    ))
);
INSERT INTO "wallet_transfers" ("id","wallet_id","bookie_name","kind","amount","is_simulation","created_at","transfer_type") VALUES('3c81e6e9-f5f0-432e-9463-06b065699484','real-sportybet','SportyBet','deposit',250,0,'2026-11-06T13:43:36.090Z','BOOKIE_TRANSFER');
INSERT INTO "wallet_transfers" ("id","wallet_id","bookie_name","kind","amount","is_simulation","created_at","transfer_type") VALUES('62211def-e34f-490a-9a80-295b8febd104','real-betboro','BetBoro','deposit',250,0,'2026-11-06T13:43:36.090Z','BOOKIE_TRANSFER');
INSERT INTO "wallet_transfers" ("id","wallet_id","bookie_name","kind","amount","is_simulation","created_at","transfer_type") VALUES('6d69333a-757a-4e79-94d1-7962a47a2ff0','real-sportybet','SportyBet','withdrawal',250,0,'2026-11-08T18:34:15.729Z','TRANSFER_TO_MOMO');
INSERT INTO "wallet_transfers" ("id","wallet_id","bookie_name","kind","amount","is_simulation","created_at","transfer_type") VALUES('a7be7e94-bc83-427e-9a23-0bb7a7400239','real-betboro','BetBoro','deposit',250,0,'2026-11-08T18:34:28.550Z','TRANSFER_TO_BOOKIE');
INSERT INTO "wallet_transfers" ("id","wallet_id","bookie_name","kind","amount","is_simulation","created_at","transfer_type") VALUES('f05b1bdc-c685-437f-a9b1-0784c73d67de','real-betboro','BetBoro','withdrawal',25,0,'2026-11-10T11:42:26.743Z','PROFIT_WITHDRAWAL');
INSERT INTO "wallet_transfers" ("id","wallet_id","bookie_name","kind","amount","is_simulation","created_at","transfer_type") VALUES('5922d29e-3752-4287-b8bb-5ff1bd024b41','sim-sportybet','SportyBet','deposit',7500,1,'2026-11-10T14:53:57.823Z','INITIAL_DEPOSIT');
INSERT INTO "wallet_transfers" ("id","wallet_id","bookie_name","kind","amount","is_simulation","created_at","transfer_type") VALUES('656245f5-eba9-4417-962f-dca7f0b5b410','sim-betboro','BetBoro','deposit',7500,1,'2026-11-10T14:53:57.823Z','INITIAL_DEPOSIT');
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('d1_migrations',18);
CREATE UNIQUE INDEX wallets_bookie_mode_idx
  ON wallets (bookie_name, is_simulation);
CREATE INDEX active_bets_mode_idx
  ON active_bets (is_simulation, created_at DESC);
CREATE INDEX history_mode_idx
  ON history (is_simulation, settled_at DESC);
CREATE INDEX mug_bets_mode_idx
  ON mug_bets (is_simulation, created_at DESC);
CREATE INDEX active_bets_kind_idx ON active_bets (is_simulation, kind);
CREATE INDEX history_logged_at_idx ON history (is_simulation, kind, logged_at);
CREATE INDEX history_kickoff_idx ON history (is_simulation, kickoff);
CREATE INDEX active_bets_event_idx ON active_bets (sr_event_id);
CREATE INDEX wallet_transfers_mode_idx
  ON wallet_transfers (is_simulation, created_at DESC);
CREATE INDEX wallet_transfers_bookie_idx
  ON wallet_transfers (is_simulation, bookie_name, created_at DESC);
