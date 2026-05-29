"use client";

import { useIntegrationRegistry } from "@openmapx/integration-framework/react";

/**
 * Resolve a single declared `dataSource` from an integration manifest by
 * `(integrationId, sourceId)`. Centralises the
 * `registry.get(id)?.dataSources?.find((ds) => ds.sourceId === sourceId)`
 * lookup that every place-panel section was hand-rolling, so attribution
 * name/URL/license updates in `manifest.json` flow through every panel.
 *
 * Returns `undefined` when the integration or matching source is absent —
 * call sites already guard on a truthy result before rendering attribution.
 */
export function useDataSourceAttribution(integrationId: string, sourceId: string) {
  const registry = useIntegrationRegistry();
  return registry.get(integrationId)?.dataSources?.find((ds) => ds.sourceId === sourceId);
}
