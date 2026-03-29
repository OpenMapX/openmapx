import type { ReactNode } from "react";
import { createContext, useContext, useMemo, useState } from "react";

interface ElevationHoverState {
  distance: number | null;
  setDistance: (d: number | null) => void;
}

const ElevationHoverContext = createContext<ElevationHoverState>({
  distance: null,
  setDistance: () => {},
});

export function ElevationHoverProvider({ children }: { children: ReactNode }) {
  const [distance, setDistance] = useState<number | null>(null);
  const value = useMemo(() => ({ distance, setDistance }), [distance]);

  return <ElevationHoverContext.Provider value={value}>{children}</ElevationHoverContext.Provider>;
}

export function useElevationHover(): ElevationHoverState {
  return useContext(ElevationHoverContext);
}
