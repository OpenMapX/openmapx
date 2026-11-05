"use client";

import { createContext, type ReactNode, useContext } from "react";
import type { ClientEnv } from "./env";

const EnvContext = createContext<ClientEnv | null>(null);

export function EnvProvider({ config, children }: { config: ClientEnv; children: ReactNode }) {
  return <EnvContext.Provider value={config}>{children}</EnvContext.Provider>;
}

export function useOptionalEnv(): ClientEnv | null {
  return useContext(EnvContext);
}

export function useEnv(): ClientEnv {
  const ctx = useOptionalEnv();
  if (!ctx) throw new Error("useEnv must be used within EnvProvider");
  return ctx;
}
