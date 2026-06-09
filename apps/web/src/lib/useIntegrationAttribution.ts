"use client";

import { dataSourceToAttribution } from "@openmapx/integration-framework";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { useMemo } from "react";
import { useMapAttributions } from "./useMapAttributions";

/**
 * Register an integration's manifest data sources via `useMapAttributions`
 * while `active` is true.
 *
 * All credit metadata is sourced from `manifest.json`'s `dataSources` —
 * never hand-rolled — via the shared `dataSourceToAttribution` helper.
 * Each Attribution becomes its own atomic side-channel source so MapLibre's
 * substring dedup collapses identical credits across layers.
 */
export function useIntegrationAttribution(integrationId: string, active: boolean): void {
  const registry = useIntegrationRegistry();
  const meta = registry.get(integrationId);
  const attributions = useMemo<Attribution[]>(() => {
    if (!active) return [];
    const sources = meta?.dataSources ?? [];
    return sources.map(dataSourceToAttribution);
  }, [active, meta]);
  useMapAttributions(`integration:${integrationId}`, attributions);
}

/**
 * Aggregate every enabled integration's manifest data sources for a given
 * domain. Use this for orchestrator-style overlays that render data sourced
 * from multiple sibling integrations (e.g. the live-transit overlay surfaces
 * vehicles published by live-transit-entur, live-transit-db-ris,
 * live-transit-motis, and live-transit-siri-sx-ch). License compliance
 * requires the strip to credit every contributing publisher, not just the
 * orchestrator's own (typically empty) manifest entry.
 */
export function useIntegrationDomainAttribution(domain: string, active: boolean): void {
  const registry = useIntegrationRegistry();
  const members = registry.getByDomain(domain);
  const attributions = useMemo<Attribution[]>(() => {
    if (!active) return [];
    const out: Attribution[] = [];
    for (const meta of members) {
      for (const ds of meta.dataSources ?? []) {
        out.push(dataSourceToAttribution(ds));
      }
    }
    return out;
  }, [active, members]);
  useMapAttributions(`domain:${domain}`, attributions);
}
