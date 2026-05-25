import {
  createManifestAttribution,
  type IntegrationContext,
} from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import * as hafas from "./provider.js";

const attribution = createManifestAttribution();
const wrap = <T>(data: T) => withAttribution(data, attribution.all(), freshnessNow());
const wrapRT = <T>(data: T) =>
  withAttribution(data, attribution.all(), freshnessNow({ hasRealtimeData: true }));

export function setup(ctx: IntegrationContext): void {
  attribution.set(ctx.manifest.dataSources ?? []);
  // Register DB HAFAS as a transit provider (VBB and BVG are registered by their own integrations)
  const dbInst = hafas.HAFAS_INSTANCES.find((i) => i.id === "db");
  if (!dbInst) return;
  ctx.registerTransitProvider({
    id: "transit-hafas-db",
    prefix: "db-hafas:",
    coverage: { bbox: [5.87, 47.27, 15.04, 55.06] },
    priority: 3,
    attribution: attribution.all(),
    capabilities: {
      stops: {
        lookup: true,
        nearby: true,
        bbox: false,
        search: true,
        infrastructure: false,
        platforms: false,
        timetable: false,
      },
      departures: true,
      arrivals: true,
      routes: { lookup: false, forStop: false, stops: false, geometry: false },
      planning: false,
      vehiclePositions: false,
      vehicleJourney: false,
      alerts: { byStop: false, byRoute: false, byBbox: false },
      facilities: false,
    },
    async getStopsNearby(lat, lng, radiusMeters) {
      return wrap(await hafas.getStopsNearby(dbInst, lat, lng, radiusMeters));
    },
    async getStop(stopId) {
      return wrap(await hafas.getStop(dbInst, stopId));
    },
    async getDepartures(stopId, minutes) {
      return wrapRT(await hafas.getDepartures(dbInst, stopId, minutes));
    },
    async getArrivals(stopId, minutes) {
      return wrapRT(await hafas.getArrivals(dbInst, stopId, minutes));
    },
    async searchStopsByName(query, limit) {
      return wrap(await hafas.searchByName(dbInst, query, limit ?? 10));
    },
  });
}
