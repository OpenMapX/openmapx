import { applyDeutschlandticketFilter } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import * as motis from "./adapter.js";
import { attributionTransitous } from "./attributions.js";
import { configureTransitous, transitousInstance } from "./instances.js";
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

export function setupCloud(ctx: IntegrationContext): void {
  const providerPolicyEnabled = ctx.config.providerPolicy !== false;
  if (
    ctx.config.hostedRuntimeFallback === false ||
    process.env.MOTIS_OPERATIONS_PROFILE === "regional-sovereign"
  ) {
    return;
  }
  configureTransitous({
    url: ctx.config.transitousUrl as string | undefined,
    userAgent: ctx.config.transitousUserAgent as string | undefined,
  });
  primeRentalFormFactors(transitousInstance);

  // Always-on soft resilience layer for local-MOTIS restarts and dev/cold-start.
  // Intentionally does not expose nearby/search/plan to avoid orchestrator fan-out;
  // those flows are handled by the local provider, which itself falls back to
  // Transitous when the local instance is unreachable.
  ctx.registerTransitProvider({
    id: "transit-motis-transitous",
    prefix: "mo:",
    coverage: { all: true },
    priority: 7,
    role: providerPolicyEnabled ? "fallback" : undefined,
    attribution: attributionTransitous(),
    capabilities: {
      stops: {
        lookup: true,
        nearby: false,
        bbox: false,
        search: false,
        infrastructure: false,
        platforms: false,
        timetable: false,
      },
      departures: true,
      arrivals: true,
      routes: { lookup: false, forStop: false, stops: false, geometry: false },
      planning: true,
      planningFeatures: {
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
  });
}
