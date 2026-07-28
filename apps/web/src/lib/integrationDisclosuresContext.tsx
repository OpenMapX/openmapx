"use client";

import type { AiSearchDisclosure, Disclosure } from "@openmapx/integration-framework";
import { createContext, useContext } from "react";

const IntegrationDisclosuresContext = createContext<Disclosure[] | undefined>([]);

export const IntegrationDisclosuresProvider = IntegrationDisclosuresContext.Provider;

export function useIntegrationDisclosures(): Disclosure[] | undefined {
  return useContext(IntegrationDisclosuresContext);
}

export function useAiSearchDisclosure(): AiSearchDisclosure | undefined {
  return useIntegrationDisclosures()?.find(
    (disclosure): disclosure is AiSearchDisclosure =>
      disclosure.type === "ai-search" && disclosure.integrationId === "search-nlp",
  );
}
