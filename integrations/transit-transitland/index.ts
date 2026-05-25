import {
  createManifestAttribution,
  type IntegrationContext,
} from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import * as transitland from "./provider.js";

const attribution = createManifestAttribution();
const wrap = <T>(data: T) => withAttribution(data, attribution.all(), freshnessNow());
const wrapRT = <T>(data: T) =>
  withAttribution(data, attribution.all(), freshnessNow({ hasRealtimeData: true }));

export function setup(ctx: IntegrationContext): void {
  attribution.set(ctx.manifest.dataSources ?? []);
  transitland.setTransitlandApiKey(ctx.config.apiKey as string | undefined);
  ctx.registerTransitProvider({
    id: "transit-transitland",
    prefix: "tl:",
    coverage: { all: true },
    priority: 9,
    attribution: attribution.all(),
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
