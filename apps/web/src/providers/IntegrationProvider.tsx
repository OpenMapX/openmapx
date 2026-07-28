"use client";

import { configureApiClient, initOverlayRegistry } from "@openmapx/core";
import {
  getCommunityModule,
  IntegrationRegistry,
  type IntegrationsResponse,
  initCommunityIntegrationRegistry,
} from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { FrameworkStringsProvider } from "@/lib/frameworkStringsContext";
import { IntegrationDisclosuresProvider } from "@/lib/integrationDisclosuresContext";

export function IntegrationProvider({ children }: { children: React.ReactNode }) {
  const { apiUrl } = useEnv();
  const initRef = useRef(false);
  const loadingBundleIdsRef = useRef(new Set<string>());
  const [, bumpCommunityModuleRevision] = useState(0);
  const apiBase = apiUrl.replace(/\/$/, "");

  configureApiClient({
    baseUrl:
      apiBase || (typeof window !== "undefined" ? window.location.origin : "http://localhost:3001"),
    credentials: "include",
  });

  useEffect(() => {
    if (!initRef.current) {
      initCommunityIntegrationRegistry();
      initRef.current = true;
    }
  }, []);

  const { data, isPending } = useQuery({
    queryKey: ["integrations", apiBase],
    queryFn: async () => {
      const res = await fetch(`${apiBase}/api/integrations`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load integrations");
      return (await res.json()) as IntegrationsResponse;
    },
    staleTime: Infinity,
  });
  const integrations = data?.integrations;
  const frameworkStrings = data?.frameworkStrings;
  // Keep policy-dependent features paused only while the shared integration
  // metadata is loading. If the request fails, an empty disclosure list lets
  // their non-cloud fallback paths continue instead of remaining disabled.
  const disclosures = isPending ? undefined : (data?.disclosures ?? []);

  // Community integration bundles import `react`, `react/jsx-runtime`, and
  // `@openmapx/core` as externals. The page's import map (apps/web/src/app/
  // layout.tsx) resolves those specifiers to the prebuilt singletons under
  // public/runtime/, so loading a community bundle is just appending a module
  // <script>.
  useEffect(() => {
    if (!integrations) return;
    for (const integration of integrations) {
      if (integration.isBuiltIn !== false) continue;
      const fe = integration.frontend;
      if (!fe?.mapLayer && !fe?.legend && !fe?.panel) continue;
      if (getCommunityModule(integration.id)) continue;
      if (loadingBundleIdsRef.current.has(integration.id)) continue;

      loadingBundleIdsRef.current.add(integration.id);
      const script = document.createElement("script");
      script.src = `${apiBase}/api/integrations/${integration.id}/bundle/index.js`;
      script.type = "module";
      script.async = true;
      script.onload = () => {
        loadingBundleIdsRef.current.delete(integration.id);
        bumpCommunityModuleRevision((revision) => revision + 1);
      };
      script.onerror = () => {
        loadingBundleIdsRef.current.delete(integration.id);
        console.error(`[IntegrationProvider] Failed to load bundle for ${integration.id}`);
      };
      document.head.appendChild(script);
    }
  }, [integrations, apiBase]);

  const registry = useMemo(() => new IntegrationRegistry(integrations ?? []), [integrations]);

  useEffect(() => {
    if (integrations?.length) {
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
