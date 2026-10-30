-- Explicit free-bet flag, so the ledger and the settlement maths never have to infer it from
-- `kind` (which also names muggy accas).
--
-- A free bet is not real cash: its stake is never debited from the free-bet bookie, only the hedge
-- leg leaves a wallet, and `total_stake` counts just that hedge stake.
ALTER TABLE active_bets ADD COLUMN is_free_bet INTEGER NOT NULL DEFAULT 0 CHECK (is_free_bet IN (0, 1));
ALTER TABLE history ADD COLUMN is_free_bet INTEGER NOT NULL DEFAULT 0 CHECK (is_free_bet IN (0, 1));

UPDATE active_bets SET is_free_bet = 1 WHERE kind = 'free';
UPDATE history SET is_free_bet = 1 WHERE kind = 'free';
