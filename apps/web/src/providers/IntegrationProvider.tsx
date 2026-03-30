"use client";

import {
  apiClient,
  IntegrationRegistry,
  IntegrationRegistryContext,
  type LoadedIntegrationMeta,
} from "@openmapx/core";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

export function IntegrationProvider({ children }: { children: React.ReactNode }) {
  const { data: integrations } = useQuery({
    queryKey: ["integrations"],
    queryFn: () => apiClient.get<LoadedIntegrationMeta[]>("/api/integrations"),
    staleTime: Infinity,
  });

  const registry = useMemo(() => new IntegrationRegistry(integrations ?? []), [integrations]);

  return (
    <IntegrationRegistryContext.Provider value={registry}>
      {children}
    </IntegrationRegistryContext.Provider>
  );
}
