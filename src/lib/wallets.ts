import type { WalletsPayload } from "../types";

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
