import { defineTransitProvider, type IntegrationContext } from "@openmapx/integration-framework";
import * as tfl from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  const { attribution, wrap, wrapRT } = defineTransitProvider(ctx);
  const access: tfl.TflAccess = { http: ctx.http, apiKey: null };
  ctx.onActivate(() => {
    const configured = ctx.config.apiKey as string | undefined;
    access.apiKey = configured && configured.length > 0 ? configured : null;
  });
  ctx.registerTransitProvider({
    id: "transit-tfl",
    prefix: "tfl:",
    coverage: { bbox: [-0.51, 51.28, 0.33, 51.69] },
    priority: 1,
    role: "enrichment",
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
      return wrap(await tfl.getStops(access, lat, lng, radiusMeters));
    },
    async getStop(id) {
      return wrap(await tfl.getStop(access, id));
    },
    async getDepartures(id, min) {
      const board = await tfl.getDepartures(access, id, min);
      return wrapRT(board.departures, undefined, { dataAsOf: board.dataAsOf });
    },
    async searchStopsByName(q, limit, context) {
      return wrap(await tfl.searchByName(access, q, limit ?? 10, context?.signal));
    },
    async getAlertsForStop(id) {
      return wrapRT(await tfl.getStopAlerts(access, id));
    },
    async getAlertsForRoute(id) {
      return wrapRT(await tfl.getRouteAlerts(access, id));
    },
  });
}
