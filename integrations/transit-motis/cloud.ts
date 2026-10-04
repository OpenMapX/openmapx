import { applyDeutschlandticketFilter } from "@openmapx/core";
import type { IntegrationContext, TransitProvider } from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import type { MotisInstance } from "@openmapx/mobility-core/motis-client";
import { getMotisVehicleRadar } from "@openmapx/mobility-core/motis-radar";
import { withAttribution } from "@openmapx/mobility-core/result";
import * as motis from "./adapter.js";
import { attributionTransitous } from "./attributions.js";
import { getMotisReachabilitySeeds, resolveMotisReachabilityCapabilities } from "./reachability.js";
import { getRentalFormFactors, primeRentalFormFactors } from "./rentals-capability.js";

function wrapTransitous<T>(data: T) {
  return withAttribution(data, attributionTransitous(), freshnessNow());
}
function wrapTransitousRT<T>(data: T) {
  return withAttribution(data, attributionTransitous(), freshnessNow({ hasRealtimeData: true }));
}

function withPrefix(id: string, prefix: "mo:"): string {
  return `${prefix}${id.replace(/^(ms:|mo:)/, "")}`;
}

/**
 * Operations Transitous serves only when it is the transit engine. Alongside a
 * self-hosted MOTIS they stay with the local provider, which falls back to
 * Transitous on its own; exposing them here too would fan out to both.
 * Route patterns, the stop timetable and trip refresh are bound to a local
 * dataset epoch and have no Transitous equivalent.
 */
function primaryOperations(transitousInstance: MotisInstance): Partial<TransitProvider> {
  const hostedReachability = () =>
    resolveMotisReachabilityCapabilities({
      source: "transitous",
      runtimeHealthy: true,
      operatorEnabled: false,
    });
  return {
    async getStopsNearby(lat, lng, radiusMeters) {
      const deg = radiusMeters / 111_320;
      return wrapTransitous(
        await motis.getStops(transitousInstance, [lng - deg, lat - deg, lng + deg, lat + deg]),
      );
    },
    async getStopsInBbox(bbox) {
      return wrapTransitous(await motis.getStops(transitousInstance, bbox));
    },
    async searchStopsByName(q, limit, context) {
      context?.signal.throwIfAborted();
      const hosted = await motis.searchByName(transitousInstance, q, limit ?? 10);
      context?.signal.throwIfAborted();
      return wrapTransitous(hosted);
    },
    async getStopPlatforms(id) {
      return wrapTransitous(
        await motis.getStopPlatforms(transitousInstance, withPrefix(id, "mo:")),
      );
    },
    async getLegGeometry(tripId, fromStopId, toStopId) {
      return wrapTransitous(
        await motis.getLegGeometry(
          transitousInstance,
          withPrefix(tripId, "mo:"),
          fromStopId ? withPrefix(fromStopId, "mo:") : undefined,
          toStopId ? withPrefix(toStopId, "mo:") : undefined,
        ),
      );
    },
    async getStopTransfers(stopId) {
      return wrapTransitous(
        await motis.getStopTransfers(transitousInstance, withPrefix(stopId, "mo:")),
      );
    },
    async getVehicleRadar(bbox) {
      return wrapTransitousRT(await getMotisVehicleRadar(transitousInstance, bbox));
    },
    async getReachabilityCapabilities() {
      return hostedReachability();
    },
    async getReachabilitySurface(request, signal) {
      const seeds = await getMotisReachabilitySeeds(transitousInstance, request, signal);
      return wrapTransitous({
        queryTime: request.queryTime,
        source: "transitous" as const,
        capabilities: hostedReachability(),
        seeds,
        thinning: { originalSeedCount: seeds.length, seedCount: seeds.length, gridMetres: 0 },
      });
    },
  };
}

/**
 * Register Transitous as a transit provider. As `primary` it is the transit
 * engine of a deployment without a self-hosted MOTIS; as `fallback` it is the
 * soft resilience layer for a local MOTIS that restarts or is still cold.
 */
export function setupCloud(
  ctx: IntegrationContext,
  transitousInstance: MotisInstance,
  role: "primary" | "fallback",
): void {
  if (
    ctx.config.hostedRuntimeFallback === false ||
    process.env.MOTIS_OPERATIONS_PROFILE === "regional-sovereign"
  ) {
    if (role === "primary") {
      ctx.log.warn(
        "[transit-motis] no local MOTIS and hosted Transitous disabled; MOTIS transit is unavailable",
      );
    }
    return;
  }
  primeRentalFormFactors(transitousInstance);
  const primary = role === "primary";

  ctx.registerTransitProvider({
    id: "transit-motis-transitous",
    prefix: "mo:",
    coverage: { all: true },
    priority: primary ? 1 : 7,
    role: primary ? "baseline" : "fallback",
    attribution: attributionTransitous(),
    capabilities: {
      stops: {
        lookup: true,
        nearby: primary,
        bbox: primary,
        search: primary,
        infrastructure: false,
        platforms: primary,
        timetable: false,
      },
      departures: true,
      arrivals: true,
      routes: { lookup: false, forStop: false, stops: false, geometry: false },
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
        elevation: true,
        get rentalFilters() {
          return getRentalFormFactors(transitousInstance).length > 0;
        },
        detailedTransfers: true,
        paging: true,
        refresh: false,
      },
      vehiclePositions: false,
      vehicleJourney: true,
      alerts: { byStop: false, byRoute: false, byBbox: false },
      facilities: false,
      ...(primary ? { reachability: { estimatedSurface: true, exactPointChecks: false } } : {}),
    },
    // Live rental form factors from the Transitous MOTIS `/rentals` (this
    // provider previously exposed none, so its rentals never reached the UI).
    planningMetadata: {
      source: "transit-motis-transitous",
      instance: "mo",
      datasetEpoch: "",
      get rentalFormFactors() {
        return getRentalFormFactors(transitousInstance);
      },
    },
    async planTrip(params) {
      const arriveBy = params.arrivalTime != null;
      const dateTime = params.arrivalTime ?? params.departureTime ?? new Date().toISOString();
      const planned = await motis.planTrip(
        transitousInstance,
        params.from.lat,
        params.from.lng,
        params.to.lat,
        params.to.lng,
        dateTime.slice(0, 10),
        dateTime.slice(11, 19),
        arriveBy,
        params.numItineraries,
        {
          modes: params.deutschlandticketOnly
            ? applyDeutschlandticketFilter(params.modes)
            : params.modes,
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
          detailedTransfers: true,
          useRoutedTransfers: true,
          datasetEpoch: params.capabilityEpoch,
          throwOnError: true,
        },
      );
      return wrapTransitousRT(planned ? [planned] : []);
    },
    async getStop(id) {
      return wrapTransitous(await motis.getStopById(transitousInstance, withPrefix(id, "mo:")));
    },
    async getDepartures(id, min) {
      return wrapTransitousRT(
        await motis.getDepartures(transitousInstance, withPrefix(id, "mo:"), min, {
          realtimeEnabled: true,
        }),
      );
    },
    async getArrivals(id, min) {
      return wrapTransitousRT(
        await motis.getArrivals(transitousInstance, withPrefix(id, "mo:"), min, {
          realtimeEnabled: true,
        }),
      );
    },
    async getVehicleJourney(tripId) {
      return wrapTransitousRT(await motis.getTrip(transitousInstance, withPrefix(tripId, "mo:")));
    },
    ...(primary ? primaryOperations(transitousInstance) : {}),
  });
}
