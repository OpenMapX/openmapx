"use client";

import { configureApiClient, createApiClient, initOverlayRegistry } from "@openmapx/core";
import { getApiIntegrations } from "@openmapx/core/api-sdk";
import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { FrameworkStringsProvider } from "@/lib/frameworkStringsContext";
import { IntegrationDisclosuresProvider } from "@/lib/integrationDisclosuresContext";
import {
  INTEGRATION_METADATA_REFRESH_MS,
  integrationRuntimeQueryKey,
} from "@/lib/integrationRuntimeQuery";

export function IntegrationProvider({ children }: { children: React.ReactNode }) {
  const { apiUrl } = useEnv();
  const apiBase = apiUrl.replace(/\/$/, "");

  const baseUrl =
    apiBase || (typeof window !== "undefined" ? window.location.origin : "http://localhost:3001");
  const client = useMemo(() => createApiClient({ baseUrl, credentials: "include" }), [baseUrl]);
  configureApiClient({ baseUrl, credentials: "include" });

  const { data, isPending } = useQuery({
    queryKey: integrationRuntimeQueryKey(apiBase),
    queryFn: async ({ signal }) => {
      const result = await getApiIntegrations(undefined, { client, signal });
      if (result.status !== 200)
        throw new Error("Integration metadata requires a complete response");
      return result.data;
    },
    staleTime: 10_000,
    refetchInterval: INTEGRATION_METADATA_REFRESH_MS,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });
  const integrations = data?.integrations;
  const frameworkStrings = data?.frameworkStrings;
  // Keep policy-dependent features paused only while the shared integration
  // metadata is loading. If the request fails, an empty disclosure list lets
  // their non-cloud fallback paths continue instead of remaining disabled.
  const disclosures = isPending ? undefined : (data?.disclosures ?? []);

  const registry = useMemo(() => new IntegrationRegistry(integrations ?? []), [integrations]);

  useEffect(() => {
    if (integrations) {
      initOverlayRegistry(integrations);
    }
  }, [integrations]);

  return (
    <IntegrationRegistryContext.Provider value={registry}>
      <IntegrationDisclosuresProvider value={disclosures}>
        <FrameworkStringsProvider value={frameworkStrings ?? {}}>
          {children}
        </FrameworkStringsProvider>
      </IntegrationDisclosuresProvider>
    </IntegrationRegistryContext.Provider>
  );
}
