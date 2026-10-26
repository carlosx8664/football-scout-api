import { useCallback, useMemo, useState, type ReactNode } from "react";
import { SimulationContext, readStoredSimulation, storeSimulation } from "../lib/simulation";

const SimulationProvider = ({ children }: { children: ReactNode }) => {
  const [enabled, setEnabledState] = useState(readStoredSimulation);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    storeSimulation(next);
  }, []);

  const toggle = useCallback(() => {
    setEnabledState((current) => {
      const next = !current;
      storeSimulation(next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ enabled, setEnabled, toggle }), [enabled, setEnabled, toggle]);

  return <SimulationContext.Provider value={value}>{children}</SimulationContext.Provider>;
};

export default SimulationProvider;
