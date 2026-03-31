"use client";

import {
  apiClient,
  getCommunityModule,
  IntegrationRegistry,
  IntegrationRegistryContext,
  initCommunityIntegrationRegistry,
  initOverlayRegistry,
  type LoadedIntegrationMeta,
} from "@openmapx/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

export function IntegrationProvider({ children }: { children: React.ReactNode }) {
  const initRef = useRef(false);

  // Initialize community integration push-based registry once
  useEffect(() => {
    if (!initRef.current) {
      initCommunityIntegrationRegistry();
      initRef.current = true;
    }
  }, []);

  const { data: integrations } = useQuery({
    queryKey: ["integrations"],
    queryFn: () =>
      apiClient.get<(LoadedIntegrationMeta & { isBuiltIn?: boolean })[]>("/api/integrations"),
    staleTime: Infinity,
  });

  // Load community integration frontend bundles
  useEffect(() => {
    if (!integrations) return;
    for (const integration of integrations) {
      if (integration.isBuiltIn !== false) continue;
      if (!integration.frontend?.mapLayer && !integration.frontend?.legend) continue;
      if (getCommunityModule(integration.id)) continue;

      const script = document.createElement("script");
      script.src = `/api/integrations/${integration.id}/bundle/index.js`;
      script.async = true;
      document.head.appendChild(script);
    }
  }, [integrations]);

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
