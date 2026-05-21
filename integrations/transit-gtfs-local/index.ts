import type { IntegrationContext } from "@openmapx/integration-framework";
import type { GtfsDeps } from "./gtfs-local.js";
import * as gtfsLocal from "./gtfs-local.js";

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

  ctx.registerProvider("transit", {
    id: "transit-gtfs-local",
    prefix: "g-",
    coverage: { bbox: [-180, -90, 180, 90] as [number, number, number, number] },
    priority: 3,
    getStopsNearby: (lat: number, lng: number, radiusMeters: number) => {
      const deg = radiusMeters / 111_320;
      const bbox: [number, number, number, number] = [lng - deg, lat - deg, lng + deg, lat + deg];
      return gtfsLocal.hasCoverage(bbox) ? gtfsLocal.getStops(bbox) : Promise.resolve([]);
    },
    getStop: (id: string) => gtfsLocal.getStopById(id),
    getDepartures: (id: string, min: number) => gtfsLocal.getDepartures(id, min),
    getArrivals: (id: string, min: number) => gtfsLocal.getArrivals(id, min),
    searchByName: (q: string, limit: number) => gtfsLocal.searchByName(q, limit),
    getStopPlatforms: (id: string) => gtfsLocal.getPlatformStops(id),
    getStopTimetable: (id: string, date: string) => gtfsLocal.getTimetable(id, date),
    getVehicleJourney: (tripId: string) => gtfsLocal.getVehicleJourney(tripId),
    getRoute: (routeId: string) => gtfsLocal.getRoute(routeId),
    getRouteStops: (routeId: string, hintStopId?: string) =>
      gtfsLocal.getRouteStops(routeId, hintStopId),
    getRoutesForStop: (stopId: string) => gtfsLocal.getRoutesForStop(stopId),
    getLegGeometry: (tripId: string, fromStopId?: string, toStopId?: string) =>
      gtfsLocal.getLegGeometry(tripId, fromStopId, toStopId),
    getFeedAttribution: async () => gtfsLocal.getFeedAttributions(),
  });
}

export type { GtfsDeps } from "./gtfs-local.js";
// Re-export for consumers
export { setDeps } from "./gtfs-local.js";
