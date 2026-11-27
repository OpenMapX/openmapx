import type { BBox } from "@openmapx/core";
import type { IntegrationContext, RealtimeProvider } from "@openmapx/integration-framework";
import {
  captureTransitContributors,
  collectOrderedProviders,
} from "@openmapx/integration-framework";
import type { LiveTransitVehicle, ServiceAlert } from "@openmapx/mobility-core/transit";
import type { LiveTransitSnapshot } from "./types.js";

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

/**
 * Drop MOTIS-interpolated vehicles for any trip that also has a real-time
 * `observed` fix from another provider — a genuine GPS position always wins over
 * a schedule-based estimate. Interpolated vehicles are kept when no observed fix
 * exists for their trip, and vehicles without a `tripId` are never dropped.
 */
export function preferObservedByTrip(vehicles: LiveTransitVehicle[]): LiveTransitVehicle[] {
  const observedTripIds = new Set<string>();
  for (const vehicle of vehicles) {
    if (vehicle.tripId && vehicle.positionKind === "observed") {
      observedTripIds.add(vehicle.tripId);
    }
  }
  return vehicles.filter(
    (vehicle) =>
      !(
        vehicle.positionKind === "interpolated" &&
        vehicle.tripId &&
        observedTripIds.has(vehicle.tripId)
      ),
  );
}

export function createLiveTransitOrchestrator(ctx: IntegrationContext) {
  /** Live-transit sources in the operator's order; unlisted ones follow by priority. */
  function getProviders(): RealtimeProvider[] {
    return collectOrderedProviders<RealtimeProvider>(ctx, "live-transit").map(
      ({ provider }) => provider,
    );
  }

  function getMatchingProviders(bbox: BBox): RealtimeProvider[] {
    return getProviders().filter((provider) => {
      if ("all" in provider.coverage) return true;
      return bboxesOverlap(bbox, provider.coverage.bbox);
    });
  }

  async function getVehicles(bbox: BBox): Promise<LiveTransitVehicle[]> {
    const providers = getMatchingProviders(bbox).filter((provider) => provider.getVehiclePositions);
    const results = await Promise.allSettled(
      providers.map(async (provider) => {
        const result = await provider.getVehiclePositions?.(bbox);
        return result ? captureTransitContributors(result.data, result.attributions) : [];
      }),
    );
    for (const [i, result] of results.entries()) {
      if (result.status === "rejected") {
        ctx.log.warn(`live-transit source ${providers[i]?.id} failed`, result.reason);
      }
    }
    if (providers.length > 0 && results.every((result) => result.status === "rejected"))
      throw new Error("Live transit sources unavailable");
    const vehicles = results.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    return preferObservedByTrip(dedupeById(vehicles));
  }

  async function getAlerts(bbox: BBox): Promise<ServiceAlert[]> {
    const providers = getMatchingProviders(bbox).filter((provider) => provider.getAlertsForBbox);
    const results = await Promise.allSettled(
      providers.map(async (provider) => {
        const result = await provider.getAlertsForBbox?.(bbox);
        return result ? captureTransitContributors(result.data, result.attributions) : [];
      }),
    );
    for (const [i, result] of results.entries()) {
      if (result.status === "rejected") {
        ctx.log.warn(`live-transit source ${providers[i]?.id} failed`, result.reason);
      }
    }
    if (providers.length > 0 && results.every((result) => result.status === "rejected"))
      throw new Error("Live transit alert sources unavailable");
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
