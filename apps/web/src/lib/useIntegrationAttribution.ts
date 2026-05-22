"use client";

import type { IntegrationDataSource } from "@openmapx/integration-framework";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { useMemo } from "react";
import { useRegisterMapAttribution } from "./mapAttributionStore";

function dataSourceToAttribution(ds: IntegrationDataSource): Attribution {
  return {
    sourceId: ds.sourceId,
    name: ds.name,
    url: ds.url,
    spdxLicense: ds.license || undefined,
    licenseUrl: ds.licenseUrl,
    attributionText: ds.attribution,
  };
}

/**
 * Register an integration's manifest data sources with the React-driven
 * attribution strip while `active` is true. Skips entries marked `dynamic`
 * (those are fetched at runtime per-result and aren't surfaced here).
 *
 * Replaces per-source MapLibre `attribution` strings that previously fed the
 * built-in `AttributionControl`.
 */
export function useIntegrationAttribution(integrationId: string, active: boolean): void {
  const registry = useIntegrationRegistry();
  const meta = registry.get(integrationId);
  const attributions = useMemo<Attribution[]>(() => {
    if (!active) return [];
    const sources = meta?.dataSources ?? [];
    return sources.filter((ds) => !ds.dynamic).map(dataSourceToAttribution);
  }, [active, meta]);
  useRegisterMapAttribution(`integration:${integrationId}`, attributions);
}
