import type { IntegrationContext } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import type { GtfsDeps } from "./gtfs-local.js";
import * as gtfsLocal from "./gtfs-local.js";

const ATTRIBUTION: Attribution[] = [
  {
    sourceId: "transit-gtfs-local",
    name: "Local GTFS Feeds",
    notes:
      "Aggregated set of imported GTFS schedules; per-feed attribution surfaced via getFeedAttribution().",
  },
];

const wrap = <T>(data: T) => withAttribution(data, ATTRIBUTION, freshnessNow());

export function setup(ctx: IntegrationContext): void {
  // Inject GTFS manager and queries from app config
  const gtfsDeps = ctx.config.gtfsDeps as GtfsDeps | undefined;
  if (gtfsDeps) {
    gtfsLocal.setDeps(gtfsDeps);
  }

  // Health check: verify PostGIS connectivity + at least one imported feed
  ctx.registerHealthCheck(async () => {
    if (!ctx.db) return { status: "down" as const, error: "Database not available" };
    try {
      const rows = await ctx.db.execute<{ count: string }[]>(
        "SELECT count(*)::text AS count FROM public.gtfs_feeds WHERE status = 'active'",
      );
      const count = Number(rows?.[0]?.count ?? 0);
      return count > 0
        ? { status: "up" as const }
        : { status: "down" as const, error: "No active GTFS feeds imported" };
    } catch {
      return { status: "down" as const, error: "PostGIS query failed" };
    }
  });

  ctx.registerTransitProvider({
    id: "transit-gtfs-local",
    prefix: "g-",
    coverage: { all: true },
    priority: 3,
    attribution: ATTRIBUTION,
    capabilities: {
      stops: {
        lookup: true,
        nearby: true,
        bbox: false,
        search: true,
        infrastructure: false,
        platforms: true,
        timetable: true,
      },
      departures: true,
      arrivals: true,
      routes: { lookup: true, forStop: true, stops: true, geometry: true },
      planning: false,
      vehiclePositions: false,
      vehicleJourney: true,
      alerts: { byStop: false, byRoute: false, byBbox: false },
      facilities: false,
    },
    async getStopsNearby(lat, lng, radiusMeters) {
      const deg = radiusMeters / 111_320;
      const bbox: [number, number, number, number] = [lng - deg, lat - deg, lng + deg, lat + deg];
      const stops = gtfsLocal.hasCoverage(bbox) ? await gtfsLocal.getStops(bbox) : [];
      return wrap(stops);
    },
    async getStop(id) {
      return wrap(await gtfsLocal.getStopById(id));
    },
    async getDepartures(id, min) {
      // Static GTFS schedule (no realtime) — not flagged as realtime.
      return wrap(await gtfsLocal.getDepartures(id, min));
    },
    async getArrivals(id, min) {
      return wrap(await gtfsLocal.getArrivals(id, min));
    },
    async searchStopsByName(q, limit) {
      return wrap(await gtfsLocal.searchByName(q, limit ?? 10));
    },
    async getStopPlatforms(id) {
      return wrap(await gtfsLocal.getPlatformStops(id));
    },
    async getStopTimetable(id, date) {
      return wrap(await gtfsLocal.getTimetable(id, date));
    },
    async getVehicleJourney(tripId) {
      return wrap(await gtfsLocal.getVehicleJourney(tripId));
    },
    async getRoute(routeId) {
      return wrap(await gtfsLocal.getRoute(routeId));
    },
    async getRouteStops(routeId, hintStopId) {
      return wrap(await gtfsLocal.getRouteStops(routeId, hintStopId));
    },
    async getRoutesForStop(stopId) {
      return wrap(await gtfsLocal.getRoutesForStop(stopId));
    },
    async getLegGeometry(tripId, fromStopId, toStopId) {
      return wrap(await gtfsLocal.getLegGeometry(tripId, fromStopId, toStopId));
    },
    getFeedAttribution: async () => gtfsLocal.getFeedAttributions(),
  });
}

export type { GtfsDeps } from "./gtfs-local.js";
// Re-export for consumers
export { setDeps } from "./gtfs-local.js";
