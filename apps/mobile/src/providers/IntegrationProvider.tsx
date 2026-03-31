import {
  apiClient,
  IntegrationRegistry,
  IntegrationRegistryContext,
  initOverlayRegistry,
  type LoadedIntegrationMeta,
} from "@openmapx/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

export function IntegrationProvider({ children }: { children: React.ReactNode }) {
  const { data: integrations } = useQuery({
    queryKey: ["integrations"],
    queryFn: () =>
      apiClient.get<(LoadedIntegrationMeta & { isBuiltIn?: boolean })[]>("/api/integrations"),
    staleTime: Infinity,
  });

  const registry = useMemo(() => new IntegrationRegistry(integrations ?? []), [integrations]);

  useEffect(() => {
    if (integrations?.length) {
      initOverlayRegistry(integrations);
    }
  }, [integrations]);

  return (
    <IntegrationRegistryContext.Provider value={registry}>
      {children}
    </IntegrationRegistryContext.Provider>
  );
}
