import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stops } from "@motis-project/motis-client";
import { applyDeutschlandticketFilter } from "@openmapx/core";
import type {
  AttributionIndexHandle,
  IntegrationContext,
  TripPlanRequest,
} from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import type { TripItinerary, TripLeg, TripPlan } from "@openmapx/mobility-core/transit";
import * as motis from "./adapter.js";
import { attributionLocal, attributionTransitous } from "./attributions.js";
import {
  type MotisInstance,
  motisLocalInstance,
  setMotisLocalUrl,
  transitousInstance,
} from "./instances.js";
import { getRentalFormFactors, primeRentalFormFactors } from "./rentals-capability.js";
import { decodeMotisLineReference, decodeMotisRoutePatternId } from "./route-pattern-id.js";

let cachedLocalReachable = false;
let cachedLocalReachableAt = 0;

const LOCAL_REACHABILITY_TTL_MS = 15_000;

interface ActiveMotisCapabilities {
  epoch?: string;
  health?: { rt?: boolean };
  rentals?: { formFactors?: string[] };
  planningFeatures?: { hasRoutedTransfers?: boolean; hasElevation?: boolean };
}

function readActiveMotisCapabilities(): ActiveMotisCapabilities | null {
  const configuredPath = process.env.MOTIS_CAPABILITY_SNAPSHOT_PATH;
  const dataDir = process.env.MOTIS_DATA_DIR;
  if (!configuredPath && !dataDir) return null;
  const path = configuredPath ?? join(dataDir as string, "mobility-capabilities.json");
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ActiveMotisCapabilities & {
      schemaVersion?: unknown;
    };
    return parsed.schemaVersion === 1 && typeof parsed.epoch === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function wrapTransitous<T>(data: T) {
  return withAttribution(data, attributionTransitous(), freshnessNow());
}
function wrapTransitousRT<T>(data: T) {
  return withAttribution(data, attributionTransitous(), freshnessNow({ hasRealtimeData: true }));
}

interface MaybeStopShape {
  id?: unknown;
  stopId?: unknown;
  tripId?: unknown;
  routeId?: unknown;
  route?: unknown;
  legs?: unknown;
  itineraries?: unknown;
  stops?: unknown;
  from?: unknown;
  to?: unknown;
  intermediateStops?: unknown;
}

/**
 * Strip the MOTIS instance prefix (`ms:` or `mo:`) from an id and find the
 * longest matching feed tag in `feedTagsByLength` where the remainder either
 * equals the tag or starts with `<tag>_`.
 *
 * MOTIS feed tags can themselves contain underscores (e.g.
 * `au-nsw_Transport-for-New-South-Wales-...`), so we cannot just split on the
 * first underscore — we must match against known tags, longest first.
 */
function feedTagFromId(id: string | undefined, feedTagsByLength: string[]): string | undefined {
  if (!id) return undefined;
  if (feedTagsByLength.length === 0) return undefined;
  const rest = id.replace(/^(ms:|mo:|mr:)/, "");
  for (const tag of feedTagsByLength) {
    if (rest === tag) return tag;
    if (rest.startsWith(`${tag}_`)) return tag;
  }
  return undefined;
}

/**
 * Walk an arbitrary MOTIS-derived response shape and collect every feed tag
 * embedded in stop/trip ids it carries. Deduplicated, insertion-ordered.
 *
 * `feedTagsByLength` should be the AttributionIndex's MOTIS feed-tag set
 * sorted longest-first so prefix matching is unambiguous. If empty, returns
 * an empty array (the caller will fall back to ATTRIBUTION_LOCAL).
 *
 * Supports: TransitStop, Departure, VehicleJourney, TripPlan, TripItinerary,
 * TripLeg, VehicleJourneyStop, VehiclePosition, and plain arrays of the above.
 * Anything it does not understand contributes zero tags.
 */
export function extractFeedTags(data: unknown, feedTagsByLength: string[]): string[] {
  const tags = new Set<string>();
  const visit = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object") return;
    const obj = node as MaybeStopShape & Record<string, unknown>;
    const candidateIds = [obj.id, obj.stopId, obj.tripId, obj.routeId];
    for (const candidate of candidateIds) {
      if (typeof candidate !== "string") continue;
      const pattern = decodeMotisRoutePatternId(candidate);
      if (pattern) {
        for (const routeId of pattern.r) {
          const tag = feedTagFromId(routeId, feedTagsByLength);
          if (tag) tags.add(tag);
        }
        continue;
      }
      const line = decodeMotisLineReference(candidate);
      if (line) {
        const tag = feedTagFromId(line.r, feedTagsByLength);
        if (tag) tags.add(tag);
        continue;
      }
      const tag = feedTagFromId(candidate, feedTagsByLength);
      if (tag) tags.add(tag);
    }
    if (Array.isArray(obj.legs)) visit(obj.legs);
    if (Array.isArray(obj.itineraries)) visit(obj.itineraries);
    if (Array.isArray(obj.stops)) visit(obj.stops);
    if (obj.route) visit(obj.route);
    if (obj.from) visit(obj.from);
    if (obj.to) visit(obj.to);
    if (Array.isArray(obj.intermediateStops)) visit(obj.intermediateStops);
  };
  visit(data);
  return Array.from(tags);
}

/**
 * Walk each itinerary leg and populate `leg.attributions` based on the feed
 * tags embedded in the leg's stop/trip ids. Leaves legs with no recognisable
 * feed tags unchanged (the trip-level envelope still credits the union).
 *
 * When `index` is missing or returns no feed tags, all legs pass through
 * untouched so single-feed planners and offline tests are behaviour-preserving.
 */
export function annotateLegsWithAttribution(
  itineraries: TripItinerary[],
  index: AttributionIndexHandle | undefined,
): TripItinerary[] {
  if (!index) return itineraries;
  const tagsByLength = index.listMotisFeedTags().sort((a, b) => b.length - a.length);
  if (tagsByLength.length === 0) return itineraries;
  return itineraries.map((itin) => ({
    ...itin,
    legs: itin.legs.map((leg) => {
      const legTags = extractFeedTags(leg, tagsByLength);
      if (legTags.length === 0) return leg;
      const attributions: Attribution[] = [];
      for (const tag of legTags) {
        const attr = index.getById(tag);
        if (attr) attributions.push(attr);
      }
      if (attributions.length === 0) return leg;
      const next: TripLeg = { ...leg, attributions };
      return next;
    }),
  }));
}

/**
 * Wrap a MOTIS-derived value with attributions resolved against the host's
 * AttributionIndex. Falls back to `ATTRIBUTION_LOCAL` when the index is
 * absent or when no feed tag in the value matches an indexed entry.
 */
function wrapLocalWithFeedAttribution<T>(
  data: T,
  index: AttributionIndexHandle | undefined,
  isRealtime = false,
) {
  if (!index) {
    return withAttribution(data, attributionLocal(), freshnessNow({ hasRealtimeData: isRealtime }));
  }
  const tagsByLength = index.listMotisFeedTags().sort((a, b) => b.length - a.length);
  const tags = extractFeedTags(data, tagsByLength);
  const matched: Attribution[] = [];
  for (const tag of tags) {
    const attr = index.getById(tag);
    if (attr) matched.push(attr);
  }
  const attributions = matched.length > 0 ? matched : attributionLocal();
  return withAttribution(data, attributions, freshnessNow({ hasRealtimeData: isRealtime }));
}

/** Check if the local MOTIS instance is reachable. */
async function isMotisReachable(): Promise<boolean> {
  try {
    const { response } = await stops({
      client: motisLocalInstance.client,
      query: { min: "0,0", max: "0.01,0.01" },
    });
    return response.ok || (response.status >= 400 && response.status < 500);
  } catch {
    return false;
  }
}

async function isMotisReachableCached(): Promise<boolean> {
  if (Date.now() - cachedLocalReachableAt < LOCAL_REACHABILITY_TTL_MS) {
    return cachedLocalReachable;
  }
  cachedLocalReachable = await isMotisReachable();
  cachedLocalReachableAt = Date.now();
  return cachedLocalReachable;
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

export function setupLocal(ctx: IntegrationContext): void {
  const providerPolicyEnabled = ctx.config.providerPolicy !== false;
  const localRouteOverlayEnabled = ctx.config.localRouteOverlay !== false;
  const realtimeCompletenessSkipEnabled = ctx.config.realtimeCompletenessSkip !== false;
  const itineraryRefreshEnabled = ctx.config.itineraryRefresh !== false;
  const hostedFallbackEnabled =
    ctx.config.hostedRuntimeFallback !== false &&
    process.env.MOTIS_OPERATIONS_PROFILE !== "regional-sovereign";
  const requireHostedFallback = (): void => {
    if (!hostedFallbackEnabled)
      throw new Error("hosted MOTIS fallback disabled by operations profile");
  };
  // Resolution order: service registry → manifest config → MOTIS_URL env →
  // localhost fallback. The env var matches the one services/data-manager
  // and live-transit-motis honour, so a single deployment-wide
  // `MOTIS_URL=…` reaches every consumer of the local instance.
  const resolved = ctx.getRequiredService("motis");
  const motisUrl =
    resolved?.url ??
    (ctx.config.endpoint as string | undefined) ??
    process.env.MOTIS_URL ??
    "http://localhost:8081";
  setMotisLocalUrl(motisUrl);
  cachedLocalReachable = false;
  cachedLocalReachableAt = 0;
  // Warm the live rental-capability probe so the access options reflect reality
  // by the time the directions panel opens.
  primeRentalFormFactors(motisLocalInstance);

  // Capture the host's AttributionIndex (when present). All MOTIS-derived
  // responses resolve feed-level attribution by looking up extracted feed
  // tags against it; without an index they fall back to ATTRIBUTION_LOCAL.
  const attributionIndex = ctx.attributionIndex;
  const activeCapabilities = readActiveMotisCapabilities();
  const requireActiveEpoch = (): string => {
    if (!activeCapabilities?.epoch) {
      throw new Error("active MOTIS dataset epoch unavailable");
    }
    return activeCapabilities.epoch;
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
    role: providerPolicyEnabled ? "baseline" : undefined,
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
        maxTransfers: true,
        transferBuffer: true,
        wheelchairRequired: true,
        bikeTransport: true,
        elevation: activeCapabilities?.planningFeatures?.hasElevation === true,
        get rentalFilters() {
          return getRentalFormFactors(motisLocalInstance).length > 0;
        },
        detailedTransfers: activeCapabilities?.planningFeatures?.hasRoutedTransfers === true,
        paging: true,
        refresh: itineraryRefreshEnabled,
      },
      vehiclePositions: false,
      vehicleJourney: true,
      alerts: { byStop: false, byRoute: false, byBbox: false },
      facilities: false,
    },
    // Rental form factors come from the live MOTIS `/rentals` endpoint (the
    // source of truth for what the engine can actually route), not the capability
    // snapshot — which may be absent/unmounted, leaving every rental access mode
    // greyed even when MOTIS has shared-mobility feeds loaded. Getters so the
    // capabilities route serialises the latest cached value.
    planningMetadata: {
      source: "transit-motis-local",
      instance: "ms",
      datasetEpoch: activeCapabilities?.epoch ?? "",
      get rentalFormFactors() {
        return getRentalFormFactors(motisLocalInstance);
      },
    },
    ...(localRouteOverlayEnabled
      ? {
          async getRoutesInBbox(bbox, zoom) {
            if (!(await isMotisReachableCached())) {
              throw new Error("local MOTIS unavailable");
            }
            return wrapLocal(
              await motis.getRoutesInBbox(motisLocalInstance, bbox, requireActiveEpoch(), zoom),
            );
          },
        }
      : {}),
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
        const local = await motis.getDepartures(motisLocalInstance, localId, min, {
          datasetEpoch: activeCapabilities?.epoch,
          realtimeEnabled:
            realtimeCompletenessSkipEnabled && activeCapabilities?.health?.rt === true,
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
      return wrapLocal(
        await motis.getLegGeometry(
          motisLocalInstance,
          withPrefix(tripId, "ms:"),
          fromStopId ? withPrefix(fromStopId, "ms:") : undefined,
          toStopId ? withPrefix(toStopId, "ms:") : undefined,
        ),
      );
    },
    async getArrivals(id, min) {
      const localId = withPrefix(id, "ms:");
      const cloudId = withPrefix(id, "mo:");
      if (await isMotisReachableCached()) {
        const local = await motis.getArrivals(motisLocalInstance, localId, min, {
          datasetEpoch: activeCapabilities?.epoch,
          realtimeEnabled:
            realtimeCompletenessSkipEnabled && activeCapabilities?.health?.rt === true,
        });
        return wrapLocalRT(local);
      }
      requireHostedFallback();
      return wrapTransitousRT(await motis.getArrivals(transitousInstance, cloudId, min));
    },
    async searchStopsByName(q, limit) {
      const lim = limit ?? 10;
      if (await isMotisReachableCached()) {
        const local = await motis.searchByName(motisLocalInstance, q, lim);
        return wrapLocal(local);
      }
      requireHostedFallback();
      return wrapTransitous(await motis.searchByName(transitousInstance, q, lim));
    },
    async planTrip(params) {
      if (!(await isMotisReachableCached())) throw new Error("local MOTIS unavailable");
      const local = await planWithInstance(motisLocalInstance, params, activeCapabilities);
      if (!local) return wrapLocalRT([]);
      const annotated: TripPlan = {
        ...local,
        itineraries: annotateLegsWithAttribution(local.itineraries, attributionIndex),
      };
      return wrapLocalRT([annotated]);
    },
    ...(itineraryRefreshEnabled
      ? {
          async refreshTrip(params) {
            if (!(await isMotisReachableCached())) throw new Error("local MOTIS unavailable");
            if (!activeCapabilities?.epoch || activeCapabilities.epoch !== params.datasetEpoch) {
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
        }
      : {}),
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
    async getReachableStops(lat, lng, maxMinutes, modes) {
      if (await isMotisReachableCached()) {
        const local = await motis.getReachable(motisLocalInstance, lat, lng, maxMinutes, { modes });
        return wrapLocalRT(local);
      }
      requireHostedFallback();
      return wrapTransitousRT(
        await motis.getReachable(transitousInstance, lat, lng, maxMinutes, { modes }),
      );
    },
    async getVehicleRadar(bbox) {
      if (await isMotisReachableCached()) {
        return wrapLocalRT(await motis.getVehicleRadar(motisLocalInstance, bbox));
      }
      requireHostedFallback();
      return wrapTransitousRT(await motis.getVehicleRadar(transitousInstance, bbox));
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
