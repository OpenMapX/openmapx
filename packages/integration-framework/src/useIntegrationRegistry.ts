"use client";

import { createContext, useContext } from "react";
import { IntegrationRegistry } from "./registry";

const emptyRegistry = new IntegrationRegistry([]);

export const IntegrationRegistryContext = createContext<IntegrationRegistry>(emptyRegistry);

export function useIntegrationRegistry(): IntegrationRegistry {
  return useContext(IntegrationRegistryContext);
}
