import type { TransfersPayload, WalletsPayload } from "../types";

interface WalletErrorPayload {
  error?: string;
}

async function request(url: string, init?: RequestInit): Promise<WalletsPayload> {
  const response = await fetch(url, init);
  const payload = (await response.json().catch(() => null)) as
    | (WalletsPayload & WalletErrorPayload)
    | null;

  if (!response.ok || !payload?.wallets) {
    throw new Error(
      payload?.error ?? `Wallet request failed (HTTP ${response.status}).`,
    );
  }

  return payload;
}

export function fetchWallets(simulation: boolean, signal?: AbortSignal) {
  return request(`/api/wallets?simulation=${simulation ? 1 : 0}`, {
    signal,
    cache: "no-store",
  });
}

/** Sets the wallet's total balance (deposit/withdrawal logging). */
export function updateWalletBalance(id: string, balance: number, simulation: boolean) {
  return request(`/api/wallets/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ balance, simulation }),
  });
}

/** Puts the four simulation wallets back to 250 GHS each (1,000 GHS total). */
export function resetSimulationWallets() {
  return request("/api/wallets/reset", { method: "POST" });
}

export function formatGhs(amount: number) {
  return `GHS ${amount.toLocaleString("en-GH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Human-looking transfer sizing shared with the API (50 GHS steps, 50–500 per movement). */
export const TRANSFER_STEP = 50;
export const MIN_TRANSFER = 50;
export const MAX_TRANSFER = 500;

/** Snaps a requirement to a believable deposit/withdrawal size, or null when nothing fits. */
export function suggestTransfer(kind: "deposit" | "withdrawal", needed: number): number | null {
  if (!Number.isFinite(needed) || needed <= 0) return null;
  const rounded =
    kind === "withdrawal"
      ? Math.floor(needed / TRANSFER_STEP) * TRANSFER_STEP
      : Math.ceil(needed / TRANSFER_STEP) * TRANSFER_STEP;
  const clamped = Math.min(MAX_TRANSFER, Math.max(MIN_TRANSFER, rounded));
  return clamped >= MIN_TRANSFER ? clamped : null;
}

export async function createTransfer(
  walletId: string,
  kind: "deposit" | "withdrawal",
  amount: number,
  simulation: boolean,
): Promise<WalletsPayload> {
  const response = await fetch(
    `/api/wallets/${encodeURIComponent(walletId)}/transfers`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, amount, simulation }),
    },
  );

  const payload = (await response.json().catch(() => null)) as
    | (WalletsPayload & { error?: string })
    | null;

  if (!response.ok || !payload?.wallets) {
    throw new Error(payload?.error ?? `Could not record the transfer (HTTP ${response.status}).`);
  }

  return payload;
}

export async function fetchTransfers(
  simulation: boolean,
  signal?: AbortSignal,
): Promise<TransfersPayload> {
  const response = await fetch(`/api/transfers?simulation=${simulation ? 1 : 0}`, {
    signal,
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as
    | (TransfersPayload & { error?: string })
    | null;

  if (!response.ok || !payload?.transfers) {
    throw new Error(payload?.error ?? `Could not load cash flow (HTTP ${response.status}).`);
  }

  return payload;
}

/** Wipes the mode's ledger (bets, history, cash flow) and re-opens every wallet at one balance. */
export async function refreshWallets(
  simulation: boolean,
  openingBalance: number,
  scope: "mode" | "all" = "mode",
): Promise<WalletsPayload> {
  return request("/api/wallets/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ simulation, openingBalance, scope }),
  });
}
