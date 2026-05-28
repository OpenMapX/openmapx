"use client";

import type { LocaleStrings } from "@openmapx/integration-framework/strings";
import { createContext, type ReactNode, useContext } from "react";

const FrameworkStringsContext = createContext<LocaleStrings | null>(null);

export function FrameworkStringsProvider({
  value,
  children,
}: {
  value: LocaleStrings;
  children: ReactNode;
}) {
  return (
    <FrameworkStringsContext.Provider value={value}>{children}</FrameworkStringsContext.Provider>
  );
}

/**
 * Read the framework shared-vocabulary strings shipped via `/api/integrations`.
 * Must be wrapped in `<FrameworkStringsProvider>` higher in the tree (done by
 * the IntegrationRegistry provider in `useIntegrationRegistry`).
 */
export function useFrameworkStrings(): LocaleStrings {
  const value = useContext(FrameworkStringsContext);
  if (!value) {
    throw new Error(
      "useFrameworkStrings() called outside a <FrameworkStringsProvider>. Make sure the integration registry has been initialised at app boot.",
    );
  }
  return value;
}
