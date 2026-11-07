-- Distinguish external capital injections from transfers between MOMO and bookie wallets.
ALTER TABLE wallet_transfers
  ADD COLUMN transfer_type TEXT NOT NULL DEFAULT 'BOOKIE_TRANSFER'
  CHECK (transfer_type IN ('BOOKIE_TRANSFER', 'CAPITAL_INJECTION'));
