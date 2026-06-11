import type { IntegrationContext } from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import * as motis from "./adapter.js";
import { attributionTransitous } from "./attributions.js";
import { configureTransitous, transitousInstance } from "./instances.js";

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
  configureTransitous({
    url: ctx.config.transitousUrl as string | undefined,
    userAgent: ctx.config.transitousUserAgent as string | undefined,
  });

  // Always-on soft resilience layer for local-MOTIS restarts and dev/cold-start.
  // Intentionally does not expose nearby/search/plan to avoid orchestrator fan-out;
  // those flows are handled by the local provider, which itself falls back to
  // Transitous when the local instance is unreachable.
  ctx.registerTransitProvider({
    id: "transit-motis-transitous",
    prefix: "mo:",
    coverage: { all: true },
    priority: 7,
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
      planning: false,
      vehiclePositions: false,
      vehicleJourney: true,
      alerts: { byStop: false, byRoute: false, byBbox: false },
      facilities: false,
    },
    // Transit route network for the line-network map overlay. Only the
    // always-on cloud provider implements this (the local provider keeps
    // bbox methods off to avoid orchestrator fan-out across both instances).
    async getRoutesInBbox(bbox) {
      return wrapTransitous(await motis.getRoutesInBbox(transitousInstance, bbox));
    },
    async getStop(id) {
      return wrapTransitous(await motis.getStopById(transitousInstance, withPrefix(id, "mo:")));
    },
    async getDepartures(id, min) {
      return wrapTransitousRT(
        await motis.getDepartures(transitousInstance, withPrefix(id, "mo:"), min),
      );
    },
    async getArrivals(id, min) {
      return wrapTransitousRT(
        await motis.getArrivals(transitousInstance, withPrefix(id, "mo:"), min),
      );
    },
    async getVehicleJourney(tripId) {
      return wrapTransitousRT(await motis.getTrip(transitousInstance, withPrefix(tripId, "mo:")));
    },
  });
}
