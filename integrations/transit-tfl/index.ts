import { defineTransitProvider, type IntegrationContext } from "@openmapx/integration-framework";
import * as tfl from "./provider.js";

const { attribution, wrap, wrapRT, init } = defineTransitProvider();

export function setup(ctx: IntegrationContext): void {
  init(ctx);
  tfl.setTflApiKey(ctx.config.apiKey as string | undefined);
  ctx.registerTransitProvider({
    id: "transit-tfl",
    prefix: "tfl:",
    coverage: { bbox: [-0.51, 51.28, 0.33, 51.69] },
    priority: 1,
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
      arrivals: false,
      routes: { lookup: false, forStop: false, stops: false, geometry: false },
      planning: false,
      vehiclePositions: false,
      vehicleJourney: false,
      alerts: { byStop: true, byRoute: true, byBbox: false },
      facilities: false,
    },
    async getStopsNearby(lat, lng, radiusMeters) {
      return wrap(await tfl.getStops(lat, lng, radiusMeters));
    },
    async getStop(id) {
      return wrap(await tfl.getStop(id));
    },
    async getDepartures(id, min) {
      return wrapRT(await tfl.getDepartures(id, min));
    },
    async searchStopsByName(q, limit) {
      return wrap(await tfl.searchByName(q, limit ?? 10));
    },
    async getAlertsForStop(id) {
      return wrapRT(await tfl.getStopAlerts(id));
    },
    async getAlertsForRoute(id) {
      return wrapRT(await tfl.getRouteAlerts(id));
    },
  });
}
