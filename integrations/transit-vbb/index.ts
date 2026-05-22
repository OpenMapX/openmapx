import type { IntegrationContext } from "@openmapx/integration-framework";
import * as hafas from "@openmapx/integration-transit-hafas/provider";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";

const ATTRIBUTION: Attribution[] = [
  {
    sourceId: "vbb",
    name: "VBB HAFAS REST API (transport.rest)",
    url: "https://v6.vbb.transport.rest/",
    licenseUrl: "https://github.com/public-transport/hafas-rest-api",
  },
];

const wrap = <T>(data: T) => withAttribution(data, ATTRIBUTION, freshnessNow());
const wrapRT = <T>(data: T) =>
  withAttribution(data, ATTRIBUTION, freshnessNow({ hasRealtimeData: true }));

export function setup(ctx: IntegrationContext): void {
  const inst = hafas.HAFAS_INSTANCES.find((i) => i.prefix === "vbb:");
  if (!inst) return;

  ctx.registerTransitProvider({
    id: "transit-vbb",
    prefix: "vbb:",
    coverage: { bbox: [11.26, 51.36, 14.77, 53.56] },
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
      planning: false,
      vehiclePositions: false,
      vehicleJourney: false,
      alerts: { byStop: true, byRoute: false, byBbox: false },
      facilities: false,
    },

    async getStopsNearby(lat, lng, radiusMeters) {
      return wrap(await hafas.getStopsNearby(inst, lat, lng, radiusMeters));
    },
    async getStop(stopId) {
      return wrap(await hafas.getStop(inst, stopId));
    },
    async getDepartures(stopId, minutes) {
      return wrapRT(await hafas.getDepartures(inst, stopId, minutes));
    },
    async getArrivals(stopId, minutes) {
      return wrapRT(await hafas.getArrivals(inst, stopId, minutes));
    },
    async searchStopsByName(query, limit) {
      return wrap(await hafas.searchByName(inst, query, limit ?? 10));
    },
    async getAlertsForStop(stopId) {
      return wrapRT(await hafas.getStopAlerts(inst, stopId));
    },
  });
}
