import type { IntegrationContext } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import * as irail from "./provider.js";

const ATTRIBUTION: Attribution[] = [
  {
    sourceId: "irail",
    name: "iRail",
    url: "https://api.irail.be/",
    spdxLicense: "AGPL-3.0",
    licenseUrl: "https://hello.irail.be/api/",
  },
];

const wrap = <T>(data: T) => withAttribution(data, ATTRIBUTION, freshnessNow());
const wrapRT = <T>(data: T) =>
  withAttribution(data, ATTRIBUTION, freshnessNow({ hasRealtimeData: true }));

export function setup(ctx: IntegrationContext): void {
  ctx.registerTransitProvider({
    id: "transit-irail",
    prefix: "ir:",
    coverage: { bbox: [2.54, 49.49, 5.92, 51.51] },
    priority: 1,
    attribution: ATTRIBUTION,
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
      planning: true,
      vehiclePositions: false,
      vehicleJourney: true,
      alerts: { byStop: false, byRoute: false, byBbox: false },
      facilities: false,
    },

    async getStopsNearby(lat, lng, radiusMeters) {
      return wrap(await irail.getStops(lat, lng, radiusMeters));
    },
    async getStop(stopId) {
      return wrap(await irail.getStopById(stopId));
    },
    async getDepartures(stopId, minutes) {
      return wrapRT(await irail.getDepartures(stopId, minutes));
    },
    async getArrivals(stopId, minutes) {
      return wrapRT(await irail.getArrivals(stopId, minutes));
    },
    async searchStopsByName(query, limit) {
      return wrap(await irail.searchByName(query, limit ?? 10));
    },
    async getVehicleJourney(vehicleId) {
      return wrapRT(await irail.getVehicleJourney(vehicleId));
    },
    async planTrip(params) {
      const now = new Date();
      const date = params.departureTime?.slice(0, 10) ?? now.toISOString().slice(0, 10);
      const time = params.departureTime?.slice(11, 19) ?? now.toISOString().slice(11, 19);
      const plan = await irail.planConnections(
        params.from.lat,
        params.from.lng,
        params.to.lat,
        params.to.lng,
        date,
        time,
      );
      return wrapRT(plan ? [plan] : []);
    },
  });
}
