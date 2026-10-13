import {
  annotateLegsWithAttribution,
  wrapMotisWithFeedAttribution as wrapLocalWithFeedAttribution,
} from "./contributors.js";

export { annotateLegsWithAttribution, extractFeedTags } from "./contributors.js";

import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stops } from "@motis-project/motis-client";
import { applyDeutschlandticketFilter } from "@openmapx/core";
import type {
  AttributionIndexHandle,
  IntegrationContext,
  TripPlanRequest,
} from "@openmapx/integration-framework";
import { captureTransitContributors } from "@openmapx/integration-framework";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import type { MotisInstance } from "@openmapx/mobility-core/motis-client";
import { getMotisVehicleRadar } from "@openmapx/mobility-core/motis-radar";
import { withAttribution } from "@openmapx/mobility-core/result";
import type { TripPlan } from "@openmapx/mobility-core/transit";
import { DEFAULT_TRANSIT_ISOCHRONE_MAX_SAMPLES } from "@openmapx/mobility-core/transit-isochrone";
import type {
  TransitReachabilityCapabilities,
  TransitReachabilitySurface,
} from "@openmapx/mobility-core/transit-reachability";
import * as motis from "./adapter.js";
import { attributionLocal, attributionTransitous } from "./attributions.js";
import type { TransitMotisInstances } from "./instances.js";
import { MAX_ONE_TO_MANY_BATCH, sampleMotisTravelTimeField } from "./isochrone.js";
import {
  captureDurationOnlyReachabilitySeeds,
  checkMotisReachabilityDestinations,
  getMotisReachabilitySeeds,
  MotisReachabilityError,
  type ObservedMotisReachabilityCapabilities,
  resolveMotisReachabilityCapabilities,
} from "./reachability.js";
import { getRentalFormFactors, primeRentalFormFactors } from "./rentals-capability.js";

const LOCAL_REACHABILITY_TTL_MS = 15_000;

interface ActiveMotisCapabilities {
  epoch?: string;
  health?: { rt?: boolean };
  rentals?: { formFactors?: string[] };
  planningFeatures?: { hasRoutedTransfers?: boolean; hasElevation?: boolean };
  reachability?: ObservedMotisReachabilityCapabilities;
}

let cachedCapabilities: ActiveMotisCapabilities | null = null;
let cachedCapabilitiesKey = "";

/**
 * The data-manager promotes datasets from a separate process, so the snapshot
 * must be re-read after promotion. Inspect and read the same open file so an
 * atomic path replacement cannot pair one generation's stat with another's data.
 */
function activeMotisCapabilities(): ActiveMotisCapabilities | null {
  const configuredPath = process.env.MOTIS_CAPABILITY_SNAPSHOT_PATH;
  const dataDir = process.env.MOTIS_DATA_DIR;
  if (!configuredPath && !dataDir) return null;
  const path = configuredPath ?? join(dataDir as string, "mobility-capabilities.json");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const stats = fstatSync(descriptor);
    const key = `${path}\u0000${stats.dev}\u0000${stats.ino}\u0000${stats.mtimeMs}\u0000${stats.ctimeMs}\u0000${stats.size}`;
    if (key === cachedCapabilitiesKey) return cachedCapabilities;
    const parsed = JSON.parse(readFileSync(descriptor, "utf8")) as ActiveMotisCapabilities & {
      schemaVersion?: unknown;
    };
    cachedCapabilities =
      parsed.schemaVersion === 1 && typeof parsed.epoch === "string" ? parsed : null;
    cachedCapabilitiesKey = key;
    return cachedCapabilities;
  } catch {
    cachedCapabilities = null;
    cachedCapabilitiesKey = "";
    return null;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the best-effort snapshot lookup's result during cleanup.
      }
    }
  }
}

function wrapTransitous<T>(data: T, receipts = attributionTransitous()) {
  return withAttribution(captureTransitContributors(data, receipts), receipts, freshnessNow());
}
function wrapTransitousRT<T>(data: T) {
  return withAttribution(
    captureTransitContributors(data, attributionTransitous()),
    attributionTransitous(),
    freshnessNow({ hasRealtimeData: true }),
  );
}

function withPrefix(id: string, prefix: "ms:" | "mo:"): string {
  return `${prefix}${id.replace(/^(ms:|mo:)/, "")}`;
}

function resolveDateTime(departureTime?: string): { date: string; time: string } {
  const now = new Date();
  return {
    date: departureTime?.slice(0, 10) ?? now.toISOString().slice(0, 10),
    time: departureTime?.slice(11, 19) ?? now.toISOString().slice(11, 19),
  };
}

/**
 * The self-hosted MOTIS endpoint, if the deployment has one: the co-deployed
 * service, the integration's `endpoint` config, or `MOTIS_URL`. Undefined
 * without one; transit then runs on Transitous directly (see cloud.ts).
 */
export function resolveLocalMotisUrl(
  serviceUrl: unknown,
  configuredEndpoint: unknown,
  environmentUrl: unknown,
): string | undefined {
  return [serviceUrl, configuredEndpoint, environmentUrl]
    .find(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.trim().length > 0,
    )
    ?.trim();
}

async function planWithInstance(
  instance: MotisInstance,
  params: TripPlanRequest,
  capabilities?: ActiveMotisCapabilities | null,
) {
  // Arrive-by when an arrival time is given; otherwise plan a departure.
  const arriveBy = params.arrivalTime != null;
  const { date, time } = resolveDateTime(arriveBy ? params.arrivalTime : params.departureTime);
  // MOTIS has no native Deutschlandticket concept, so approximate it by
  // intersecting the requested modes with the covered (regional/local) set.
  const modes = params.deutschlandticketOnly
    ? applyDeutschlandticketFilter(params.modes)
    : params.modes;
  return motis.planTrip(
    instance,
    params.from.lat,
    params.from.lng,
    params.to.lat,
    params.to.lng,
    date,
    time,
    arriveBy,
    params.numItineraries,
    {
      modes,
      wheelchair: params.wheelchairRequired ?? params.wheelchair,
      preTransitModes: params.preTransitModes,
      postTransitModes: params.postTransitModes,
      directModes: params.directModes,
      maxTransfers: params.maxTransfers,
      transferBuffer: params.transferBuffer,
      requireBikeTransport: params.requireBikeTransport,
      bikeHillPreference: params.bikeHillPreference,
      rentalFilters: params.rentalFilters,
      pageCursor: params.pageCursor,
      detailedLegs: true,
      detailedTransfers: capabilities?.planningFeatures?.hasRoutedTransfers === true,
      useRoutedTransfers: capabilities?.planningFeatures?.hasRoutedTransfers === true,
      datasetEpoch: capabilities?.epoch ?? params.capabilityEpoch,
      throwOnError: true,
    },
  );
}

export function setupLocal(ctx: IntegrationContext, instances: TransitMotisInstances): void {
  const { motisLocalInstance, motisLocalReachabilityInstance, transitousInstance } = instances;
  let cachedLocalReachable = false;
  let cachedLocalReachableAt = 0;
  const isMotisReachable = async (): Promise<boolean> => {
    try {
      const { response } = await stops({
        client: motisLocalInstance.client,
        query: { min: "0,0", max: "0.01,0.01" },
      });
      return response.ok || (response.status >= 400 && response.status < 500);
    } catch {
      return false;
    }
  };
  const isMotisReachableCached = async (): Promise<boolean> => {
    if (Date.now() - cachedLocalReachableAt < LOCAL_REACHABILITY_TTL_MS) {
      return cachedLocalReachable;
    }
    cachedLocalReachable = await isMotisReachable();
    cachedLocalReachableAt = Date.now();
    return cachedLocalReachable;
  };
  const hostedFallbackEnabled =
    ctx.config.hostedRuntimeFallback !== false &&
    process.env.MOTIS_OPERATIONS_PROFILE !== "regional-sovereign";
  const requireHostedFallback = (): void => {
    if (!hostedFallbackEnabled)
      throw new Error("hosted MOTIS fallback disabled by operations profile");
  };
  // Warm the live rental-capability probe so the access options reflect reality
  // by the time the directions panel opens.
  primeRentalFormFactors(motisLocalInstance);

  // Capture the host's AttributionIndex (when present). All MOTIS-derived
  // responses resolve feed-level attribution by looking up extracted feed
  // tags against it; without an index the feed supplier remains unknown.
  const attributionIndex = ctx.attributionIndex;
  const exactReachabilityEnabled = ctx.config.exactReachabilityEnabled === true;
  const exportableIsochronesEnabled = ctx.config.exportableIsochronesEnabled === true;
  const requireActiveEpoch = (): string => {
    const epoch = activeMotisCapabilities()?.epoch;
    if (!epoch) {
      throw new Error("active MOTIS dataset epoch unavailable");
    }
    return epoch;
  };

  const wrapLocal = <T>(data: T) => wrapLocalWithFeedAttribution(data, attributionIndex, false);
  const wrapLocalRT = <T>(data: T) => wrapLocalWithFeedAttribution(data, attributionIndex, true);

  // Register local-first MOTIS provider.
  // For bbox/search/plan we only expose this provider to avoid fan-out to both local + cloud.
  ctx.registerTransitProvider({
    id: "transit-motis-local",
    prefix: "ms:",
    coverage: { all: true },
    priority: 1,
    role: "baseline",
    attribution: attributionLocal(),
    capabilities: {
      stops: {
        lookup: true,
        nearby: true,
        bbox: true,
        search: true,
        infrastructure: false,
        platforms: true,
        timetable: true,
      },
      departures: true,
      arrivals: true,
      routes: { lookup: true, forStop: true, stops: true, geometry: true },
      planning: true,
      planningFeatures: {
        chaining: true,
        temporal: {
          tripDepartAt: "native",
          tripArriveBy: "native",
          dwell: "emulated",
          waypointDepartAfter: "emulated",
          waypointArriveBy: "emulated",
          timeDependentTravel: "native",
        },
        maxTransfers: true,
        transferBuffer: true,
        wheelchairRequired: true,
        bikeTransport: true,
        get elevation() {
          return activeMotisCapabilities()?.planningFeatures?.hasElevation === true;
        },
        get rentalFilters() {
          return getRentalFormFactors(motisLocalInstance).length > 0;
        },
        get detailedTransfers() {
          return activeMotisCapabilities()?.planningFeatures?.hasRoutedTransfers === true;
        },
        paging: true,
        refresh: true,
      },
      vehiclePositions: false,
      vehicleJourney: true,
      alerts: { byStop: false, byRoute: false, byBbox: false },
      facilities: false,
      reachability: { estimatedSurface: true, exactPointChecks: true },
    },
    // Rental form factors come from the live MOTIS `/rentals` endpoint (the
    // source of truth for what the engine can actually route), not the capability
    // snapshot — which may be absent/unmounted, leaving every rental access mode
    // greyed even when MOTIS has shared-mobility feeds loaded. Getters so the
    // capabilities route serialises the latest cached value.
    planningMetadata: {
      source: "transit-motis-local",
      instance: "ms",
      get datasetEpoch() {
        return activeMotisCapabilities()?.epoch ?? "";
      },
      get rentalFormFactors() {
        return getRentalFormFactors(motisLocalInstance);
      },
    },
    async getRoutesInBbox(bbox, zoom) {
      if (!(await isMotisReachableCached())) {
        throw new Error("local MOTIS unavailable");
      }
      return wrapLocal(
        await motis.getRoutesInBbox(motisLocalInstance, bbox, requireActiveEpoch(), zoom),
      );
    },
    async getStopsNearby(lat, lng, radiusMeters) {
      const deg = radiusMeters / 111_320;
      if (await isMotisReachableCached()) {
        const local = await motis.getStops(motisLocalInstance, [
          lng - deg,
          lat - deg,
          lng + deg,
          lat + deg,
        ]);
        return wrapLocal(local);
      }
      requireHostedFallback();
      return wrapTransitous(
        await motis.getStops(transitousInstance, [lng - deg, lat - deg, lng + deg, lat + deg]),
      );
    },
    async getStopsInBbox(bbox) {
      if (!(await isMotisReachableCached())) throw new Error("local MOTIS unavailable");
      return wrapLocal(await motis.getStops(motisLocalInstance, bbox));
    },
    async getStop(id) {
      const localId = withPrefix(id, "ms:");
      const cloudId = withPrefix(id, "mo:");
      if (await isMotisReachableCached()) {
        const local = await motis.getStopById(motisLocalInstance, localId);
        return wrapLocal(local);
      }
      requireHostedFallback();
      return wrapTransitous(await motis.getStopById(transitousInstance, cloudId));
    },
    async getDepartures(id, min) {
      const localId = withPrefix(id, "ms:");
      const cloudId = withPrefix(id, "mo:");
      if (await isMotisReachableCached()) {
        const capabilities = activeMotisCapabilities();
        const local = await motis.getDepartures(motisLocalInstance, localId, min, {
          datasetEpoch: capabilities?.epoch,
          realtimeEnabled: capabilities?.health?.rt === true,
        });
        return wrapLocalRT(local);
      }
      requireHostedFallback();
      return wrapTransitousRT(await motis.getDepartures(transitousInstance, cloudId, min));
    },
    async getStopPlatforms(id) {
      if (!(await isMotisReachableCached())) throw new Error("local MOTIS unavailable");
      return wrapLocal(await motis.getStopPlatforms(motisLocalInstance, withPrefix(id, "ms:")));
    },
    async getStopTimetable(id, date) {
      if (!(await isMotisReachableCached())) throw new Error("local MOTIS unavailable");
      return wrapLocal(
        await motis.getStopTimetable(
          motisLocalInstance,
          withPrefix(id, "ms:"),
          date,
          requireActiveEpoch(),
        ),
      );
    },
    async getRoute(routeId) {
      if (!(await isMotisReachableCached())) throw new Error("local MOTIS unavailable");
      return wrapLocal(await motis.getRoute(motisLocalInstance, routeId, requireActiveEpoch()));
    },
    async getRoutesForStop(stopId) {
      if (!(await isMotisReachableCached())) throw new Error("local MOTIS unavailable");
      return wrapLocal(
        await motis.getRoutesForStop(
          motisLocalInstance,
          withPrefix(stopId, "ms:"),
          requireActiveEpoch(),
        ),
      );
    },
    async getRouteStops(routeId, hintStopId) {
      if (!(await isMotisReachableCached())) throw new Error("local MOTIS unavailable");
      return wrapLocal(
        await motis.getRouteStops(
          motisLocalInstance,
          routeId,
          requireActiveEpoch(),
          hintStopId ? withPrefix(hintStopId, "ms:") : undefined,
        ),
      );
    },
    async getLegGeometry(tripId, fromStopId, toStopId) {
      if (!(await isMotisReachableCached())) throw new Error("local MOTIS unavailable");
      const localTripId = withPrefix(tripId, "ms:");
      const geometry = await motis.getLegGeometry(
        motisLocalInstance,
        localTripId,
        fromStopId ? withPrefix(fromStopId, "ms:") : undefined,
        toStopId ? withPrefix(toStopId, "ms:") : undefined,
      );
      if (!geometry) return wrapLocal(null);
      // The geometry endpoint omits IDs; its typed trip request certifies the
      // selected service shape, rather than every loaded timetable feed.
      const serving = wrapLocal({ tripId: localTripId });
      return wrapLocal({ ...geometry, contributors: serving.attributions });
    },
    async getArrivals(id, min) {
      const localId = withPrefix(id, "ms:");
      const cloudId = withPrefix(id, "mo:");
      if (await isMotisReachableCached()) {
        const capabilities = activeMotisCapabilities();
        const local = await motis.getArrivals(motisLocalInstance, localId, min, {
          datasetEpoch: capabilities?.epoch,
          realtimeEnabled: capabilities?.health?.rt === true,
        });
        return wrapLocalRT(local);
      }
      requireHostedFallback();
      return wrapTransitousRT(await motis.getArrivals(transitousInstance, cloudId, min));
    },
    async searchStopsByName(q, limit, context) {
      const lim = limit ?? 10;
      context?.signal.throwIfAborted();
      if (await isMotisReachableCached()) {
        const local = await motis.searchByName(motisLocalInstance, q, lim);
        context?.signal.throwIfAborted();
        return wrapLocal(local);
      }
      requireHostedFallback();
      const hosted = await motis.searchByName(transitousInstance, q, lim);
      context?.signal.throwIfAborted();
      return wrapTransitous(hosted);
    },
    async planTrip(params) {
      if (!(await isMotisReachableCached())) throw new Error("local MOTIS unavailable");
      const local = await planWithInstance(motisLocalInstance, params, activeMotisCapabilities());
      if (!local) return wrapLocalRT([]);
      const annotated: TripPlan = {
        ...local,
        itineraries: annotateLegsWithAttribution(local.itineraries, attributionIndex),
      };
      return wrapLocalRT([annotated]);
    },
    async refreshTrip(params) {
      if (!(await isMotisReachableCached())) throw new Error("local MOTIS unavailable");
      const epoch = activeMotisCapabilities()?.epoch;
      if (!epoch || epoch !== params.datasetEpoch) {
        return wrapLocalRT(null);
      }
      const refreshed = await motis.refreshTrip(motisLocalInstance, params.itineraryId, {
        modes: params.modes,
        wheelchair: params.wheelchairRequired,
        requireBikeTransport: params.requireBikeTransport,
        detailedTransfers: params.detailedTransfers,
        datasetEpoch: params.datasetEpoch,
      });
      return wrapLocalRT(refreshed);
    },
    async getVehicleJourney(tripId) {
      const localId = withPrefix(tripId, "ms:");
      const cloudId = withPrefix(tripId, "mo:");
      if (await isMotisReachableCached()) {
        const local = await motis.getTrip(motisLocalInstance, localId);
        if (local) return wrapLocalRT(local);
      }
      requireHostedFallback();
      return wrapTransitousRT(await motis.getTrip(transitousInstance, cloudId));
    },
    async getReachabilityCapabilities(): Promise<TransitReachabilityCapabilities> {
      const localHealthy = await isMotisReachableCached();
      if (localHealthy) {
        const active = activeMotisCapabilities();
        return resolveMotisReachabilityCapabilities({
          source: "self-hosted-motis",
          runtimeHealthy: true,
          operatorEnabled: exactReachabilityEnabled,
          exportableIsochronesEnabled,
          datasetEpoch: active?.epoch,
          observed: active?.reachability,
        });
      }
      return resolveMotisReachabilityCapabilities({
        source: hostedFallbackEnabled ? "transitous" : "self-hosted-motis",
        runtimeHealthy: hostedFallbackEnabled,
        operatorEnabled: false,
      });
    },
    async getReachabilitySurface(request, signal) {
      const localHealthy = await isMotisReachableCached();
      if (localHealthy) {
        try {
          const active = activeMotisCapabilities();
          const capabilities = resolveMotisReachabilityCapabilities({
            source: "self-hosted-motis",
            runtimeHealthy: true,
            operatorEnabled: exactReachabilityEnabled,
            exportableIsochronesEnabled,
            datasetEpoch: active?.epoch,
            observed: active?.reachability,
          });
          const seeds = await getMotisReachabilitySeeds(motisLocalInstance, request, signal);
          const surface: TransitReachabilitySurface = {
            queryTime: request.queryTime,
            source: "self-hosted-motis",
            capabilities,
            seeds,
            thinning: { originalSeedCount: seeds.length, seedCount: seeds.length, gridMetres: 0 },
          };
          return wrapLocal(surface);
        } catch (error) {
          ctx.log.warn(
            `[transit-motis] local reachability surface failed: ${(error as Error).message}`,
          );
          if (signal?.aborted) throw error;
        }
      }
      requireHostedFallback();
      const receipts = snapshotContributors(attributionTransitous());
      const seeds = captureDurationOnlyReachabilitySeeds(
        await getMotisReachabilitySeeds(transitousInstance, request, signal),
        receipts,
      );
      const capabilities = resolveMotisReachabilityCapabilities({
        source: "transitous",
        runtimeHealthy: true,
        operatorEnabled: false,
      });
      return wrapTransitous(
        {
          queryTime: request.queryTime,
          source: "transitous" as const,
          lineageComplete: false,
          capabilities,
          seeds,
          thinning: { originalSeedCount: seeds.length, seedCount: seeds.length, gridMetres: 0 },
        },
        receipts,
      );
    },
    async checkReachabilityDestinations(request, signal) {
      if (!(await isMotisReachableCached())) {
        throw new MotisReachabilityError("unavailable", "self-hosted MOTIS is unavailable");
      }
      const active = activeMotisCapabilities();
      const capabilities = resolveMotisReachabilityCapabilities({
        source: "self-hosted-motis",
        runtimeHealthy: true,
        operatorEnabled: exactReachabilityEnabled,
        exportableIsochronesEnabled,
        datasetEpoch: active?.epoch,
        observed: active?.reachability,
      });
      if (!capabilities.exactPointChecks || !capabilities.maxDestinationsPerBatch) {
        throw new MotisReachabilityError(
          "unsupported",
          `exact reachability is disabled: ${capabilities.exactPointCheckReason}`,
        );
      }
      return wrapLocal(
        await checkMotisReachabilityDestinations(
          motisLocalReachabilityInstance,
          request,
          capabilities.maxDestinationsPerBatch,
          signal,
        ),
      );
    },
    async getTransitTravelTimeField(request, signal) {
      if (!(await isMotisReachableCached())) {
        throw new MotisReachabilityError("unavailable", "self-hosted MOTIS is unavailable");
      }
      const active = activeMotisCapabilities();
      const capabilities = resolveMotisReachabilityCapabilities({
        source: "self-hosted-motis",
        runtimeHealthy: true,
        operatorEnabled: exactReachabilityEnabled,
        exportableIsochronesEnabled,
        datasetEpoch: active?.epoch,
        observed: active?.reachability,
      });
      if (!capabilities.exportableIsochrones) {
        throw new MotisReachabilityError(
          "unsupported",
          `exportable transit isochrones are disabled: ${capabilities.exportableIsochroneReason}`,
        );
      }
      return wrapLocal(
        await sampleMotisTravelTimeField(
          motisLocalReachabilityInstance,
          request,
          {
            maxBatchSize: capabilities.maxDestinationsPerBatch ?? MAX_ONE_TO_MANY_BATCH,
            maxSamples: DEFAULT_TRANSIT_ISOCHRONE_MAX_SAMPLES,
            deadlineMs: 60_000,
          },
          signal,
        ),
      );
    },
    async getVehicleRadar(bbox) {
      if (await isMotisReachableCached()) {
        return wrapLocalRT(await getMotisVehicleRadar(motisLocalInstance, bbox));
      }
      requireHostedFallback();
      return wrapTransitousRT(await getMotisVehicleRadar(transitousInstance, bbox));
    },
    async getStopTransfers(stopId) {
      const localId = withPrefix(stopId, "ms:");
      const cloudId = withPrefix(stopId, "mo:");
      if (await isMotisReachableCached()) {
        return wrapLocal(await motis.getStopTransfers(motisLocalInstance, localId));
      }
      requireHostedFallback();
      return wrapTransitous(await motis.getStopTransfers(transitousInstance, cloudId));
    },
  });
}

export const __testing = {
  wrapLocal: <T>(data: T, index: AttributionIndexHandle | undefined) =>
    wrapLocalWithFeedAttribution(data, index, false),
  wrapLocalRT: <T>(data: T, index: AttributionIndexHandle | undefined) =>
    wrapLocalWithFeedAttribution(data, index, true),
  attributionLocal,
};
