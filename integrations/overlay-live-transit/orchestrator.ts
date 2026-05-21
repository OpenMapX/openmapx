import type { BBox, ServiceAlert } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import type { LiveTransitProvider, LiveTransitSnapshot, LiveTransitVehicle } from "./types.js";

function bboxesOverlap(a: BBox, b: BBox): boolean {
  return a[2] > b[0] && b[2] > a[0] && a[3] > b[1] && b[3] > a[1];
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

export function createLiveTransitOrchestrator(ctx: IntegrationContext) {
  function getProviders(): LiveTransitProvider[] {
    const providers: LiveTransitProvider[] = [];
    for (const integration of ctx.getIntegrationsByDomain("live-transit")) {
      for (const provider of (integration.providers.get("live-transit") ??
        []) as LiveTransitProvider[]) {
        providers.push(provider);
      }
    }
    return providers.sort((a, b) => a.priority - b.priority);
  }

  function getMatchingProviders(bbox: BBox): LiveTransitProvider[] {
    return getProviders().filter((provider) =>
      provider.coverage?.bbox ? bboxesOverlap(bbox, provider.coverage.bbox) : true,
    );
  }

  async function getVehicles(bbox: BBox): Promise<LiveTransitVehicle[]> {
    const results = await Promise.allSettled(
      getMatchingProviders(bbox).map((provider) => provider.getVehicles(bbox)),
    );
    return dedupeById(
      results.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
    );
  }

  async function getAlerts(bbox: BBox): Promise<ServiceAlert[]> {
    const results = await Promise.allSettled(
      getMatchingProviders(bbox)
        .filter((provider) => provider.getAlerts)
        .map((provider) => provider.getAlerts?.(bbox) ?? Promise.resolve([])),
    );
    return dedupeById(
      results.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
    );
  }

  async function getSnapshot(bbox: BBox): Promise<LiveTransitSnapshot> {
    const [vehicles, alerts] = await Promise.all([getVehicles(bbox), getAlerts(bbox)]);
    return { vehicles, alerts };
  }

  return { getVehicles, getAlerts, getSnapshot };
}
