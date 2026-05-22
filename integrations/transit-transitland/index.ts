import type { IntegrationContext } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import * as transitland from "./provider.js";

const ATTRIBUTION: Attribution[] = [
  {
    sourceId: "transitland",
    name: "Transitland (Interline)",
    url: "https://transit.land/",
    licenseUrl: "https://www.transit.land/terms",
  },
];

const wrap = <T>(data: T) => withAttribution(data, ATTRIBUTION, freshnessNow());
const wrapRT = <T>(data: T) =>
  withAttribution(data, ATTRIBUTION, freshnessNow({ hasRealtimeData: true }));

export function setup(ctx: IntegrationContext): void {
  transitland.setTransitlandApiKey(ctx.config.apiKey as string | undefined);
  ctx.registerTransitProvider({
    id: "transit-transitland",
    prefix: "tl:",
    coverage: { all: true },
    priority: 9,
    attribution: ATTRIBUTION,
    capabilities: {
      stops: {
        lookup: true,
        nearby: true,
        bbox: false,
        search: false,
        infrastructure: false,
        platforms: false,
        timetable: false,
      },
      departures: true,
      arrivals: false,
      routes: { lookup: true, forStop: false, stops: false, geometry: false },
      planning: false,
      vehiclePositions: false,
      vehicleJourney: false,
      alerts: { byStop: false, byRoute: false, byBbox: false },
      facilities: false,
    },
    async getStopsNearby(lat, lng, radiusMeters) {
      const deg = radiusMeters / 111_320;
      return wrap(await transitland.getStops([lng - deg, lat - deg, lng + deg, lat + deg]));
    },
    async getStop(id) {
      return wrap(await transitland.getStop(id));
    },
    async getDepartures(id, min) {
      return wrapRT(await transitland.getDepartures(id, min));
    },
    async getRoute(id) {
      return wrap(await transitland.getRoute(id));
    },
  });
}
