import { createContext, useContext } from "react";

export const SIMULATION_STORAGE_KEY = "oddtor:simulation-mode";

export interface SimulationMode {
  /** True = read/write rows where `is_simulation = 1`. */
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  toggle: () => void;
}

export const SimulationContext = createContext<SimulationMode | null>(null);

export function useSimulation(): SimulationMode {
  const context = useContext(SimulationContext);
  if (!context) {
    throw new Error("useSimulation must be used inside <SimulationProvider>.");
  }
  return context;
}

/** Simulation is the default: the seeded wallets (4 x 250 GHS) are simulated money. */
export function readStoredSimulation(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(SIMULATION_STORAGE_KEY) !== "0";
}

export function storeSimulation(enabled: boolean) {
  window.localStorage.setItem(SIMULATION_STORAGE_KEY, enabled ? "1" : "0");
}
