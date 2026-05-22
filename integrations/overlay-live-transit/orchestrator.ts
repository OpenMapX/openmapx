import type { BBox } from "@openmapx/core";
import type { IntegrationContext, RealtimeProvider } from "@openmapx/integration-framework";
import type { ServiceAlert } from "@openmapx/mobility-core/transit";
import type { LiveTransitSnapshot, LiveTransitVehicle } from "./types.js";

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
  function getProviders(): RealtimeProvider[] {
    const providers: RealtimeProvider[] = [];
    for (const integration of ctx.getIntegrationsByDomain("live-transit")) {
      for (const provider of (integration.providers.get("live-transit") ??
        []) as RealtimeProvider[]) {
        providers.push(provider);
      }
    }
    return providers.sort((a, b) => a.priority - b.priority);
  }

  function getMatchingProviders(bbox: BBox): RealtimeProvider[] {
    return getProviders().filter((provider) => {
      if ("all" in provider.coverage) return true;
      return bboxesOverlap(bbox, provider.coverage.bbox);
    });
  }

  async function getVehicles(bbox: BBox): Promise<LiveTransitVehicle[]> {
    const results = await Promise.allSettled(
      getMatchingProviders(bbox)
        .filter((provider) => provider.getVehiclePositions)
        .map(async (provider) => {
          const result = await provider.getVehiclePositions?.(bbox);
          return result?.data ?? [];
        }),
    );
    const vehicles = results.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    // The realtime contract returns the framework's `VehiclePosition[]`;
    // the underlying providers actually produce the richer `LiveTransitVehicle`
    // shape at runtime (structural superset), so we cast back here.
    return dedupeById(vehicles as LiveTransitVehicle[]);
  }

  async function getAlerts(bbox: BBox): Promise<ServiceAlert[]> {
    const results = await Promise.allSettled(
      getMatchingProviders(bbox)
        .filter((provider) => provider.getAlertsForBbox)
        .map(async (provider) => {
          const result = await provider.getAlertsForBbox?.(bbox);
          return result?.data ?? [];
        }),
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
