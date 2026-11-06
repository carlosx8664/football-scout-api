import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  BankrollContext,
  readStoredBankroll,
  storeBankroll,
  type BankrollSettings,
} from "../lib/bankroll";
import { useSimulation } from "../lib/simulation";

/** Holds an independent bankroll/stake plan for each simulation mode. */
const BankrollProvider = ({ children }: { children: ReactNode }) => {
  const { enabled: simulation } = useSimulation();
  const [settingsByMode, setSettingsByMode] = useState<Record<"sim" | "real", BankrollSettings>>(
    () => ({
      sim: readStoredBankroll(true),
      real: readStoredBankroll(false),
    }),
  );
  const mode = simulation ? "sim" : "real";
  const settings = settingsByMode[mode];

  const setSettings = useCallback((next: BankrollSettings) => {
    setSettingsByMode((current) => ({ ...current, [mode]: next }));
    storeBankroll(next, simulation);
  }, [mode, simulation]);

  const value = useMemo(() => ({ settings, setSettings }), [settings, setSettings]);

  return <BankrollContext.Provider value={value}>{children}</BankrollContext.Provider>;
};

export default BankrollProvider;
