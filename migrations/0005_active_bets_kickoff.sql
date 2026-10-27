-- The card should show when the match starts, not when the bet was logged.
ALTER TABLE active_bets ADD COLUMN kickoff INTEGER;
