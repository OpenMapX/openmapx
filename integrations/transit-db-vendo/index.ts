import type { IntegrationContext } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import * as dbVendo from "./provider.js";

const ATTRIBUTION: Attribution[] = [
  {
    sourceId: "db-vendo",
    name: "Deutsche Bahn (db-vendo-client)",
    url: "https://www.bahn.de/",
    licenseUrl: "https://github.com/public-transport/db-vendo-client",
  },
];

const wrap = <T>(data: T) => withAttribution(data, ATTRIBUTION, freshnessNow());
const wrapRT = <T>(data: T) =>
  withAttribution(data, ATTRIBUTION, freshnessNow({ hasRealtimeData: true }));

export function setup(ctx: IntegrationContext): void {
  dbVendo.setDbVendoUserAgent(ctx.config.userAgent as string | undefined);
  ctx.registerTransitProvider({
    id: "transit-db-vendo",
    prefix: "db:",
    coverage: { bbox: [5.87, 47.27, 15.04, 55.06] },
    priority: 6,
    attribution: ATTRIBUTION,
    capabilities: {
      stops: {
        lookup: true,
        nearby: true,
        bbox: false,
        search: true,
        infrastructure: false,
        platforms: true,
        timetable: false,
      },
      departures: true,
      arrivals: true,
      routes: { lookup: false, forStop: false, stops: false, geometry: true },
      planning: true,
      vehiclePositions: false,
      vehicleJourney: true,
      alerts: { byStop: true, byRoute: false, byBbox: false },
      facilities: false,
    },
    async getStopsNearby(lat, lng, r) {
      return wrap(await dbVendo.getStopsNearby(lat, lng, r));
    },
    async getStop(id) {
      return wrap(await dbVendo.getStop(id));
    },
    async getDepartures(id, min) {
      return wrapRT(await dbVendo.getDepartures(id, min));
    },
    async getArrivals(id, min) {
      return wrapRT(await dbVendo.getArrivals(id, min));
    },
    async searchStopsByName(q, limit) {
      return wrap(await dbVendo.searchByName(q, limit ?? 10));
    },
    async getStopPlatforms(id) {
      return wrap(await dbVendo.getPlatformStops(id));
    },
    async getAlertsForStop(id) {
      return wrapRT(await dbVendo.getStopAlerts(id));
    },
    async planTrip(params) {
      const now = new Date();
      const date = params.departureTime?.slice(0, 10) ?? now.toISOString().slice(0, 10);
      const time = params.departureTime?.slice(11, 19) ?? now.toISOString().slice(11, 19);
      const plan = await dbVendo.planJourney(
        params.from.lat,
        params.from.lng,
        params.to.lat,
        params.to.lng,
        date,
        time,
      );
      return wrapRT(plan ? [plan] : []);
    },
    async getVehicleJourney(tripId) {
      return wrapRT(await dbVendo.getTrip(tripId));
    },
    async getLegGeometry(tripId, fromStopId, toStopId) {
      return wrap(await dbVendo.getLegGeometry(tripId, fromStopId, toStopId));
    },
  });
}
