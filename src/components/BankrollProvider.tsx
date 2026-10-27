import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  BankrollContext,
  readStoredBankroll,
  storeBankroll,
  type BankrollSettings,
} from "../lib/bankroll";

/** Holds the bankroll/stake plan so every panel on the page reads the same numbers. */
const BankrollProvider = ({ children }: { children: ReactNode }) => {
  const [settings, setSettingsState] = useState<BankrollSettings>(readStoredBankroll);

  const setSettings = useCallback((next: BankrollSettings) => {
    setSettingsState(next);
    storeBankroll(next);
  }, []);

  const value = useMemo(() => ({ settings, setSettings }), [settings, setSettings]);

  return <BankrollContext.Provider value={value}>{children}</BankrollContext.Provider>;
};

export default BankrollProvider;
