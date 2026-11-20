import { defineTransitProvider, type IntegrationContext } from "@openmapx/integration-framework";
import * as transitland from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  const { attribution, wrap, wrapRT } = defineTransitProvider(ctx);
  const access: transitland.TransitlandAccess = { http: ctx.http, apiKey: null };
  ctx.onActivate(() => {
    const configured = ctx.config.apiKey as string | undefined;
    access.apiKey = configured && configured.length > 0 ? configured : null;
  });
  ctx.registerTransitProvider({
    id: "transit-transitland",
    prefix: "tl:",
    coverage: { all: true },
    priority: 9,
    role: "enrichment",
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
      return wrap(await transitland.getStops(access, [lng - deg, lat - deg, lng + deg, lat + deg]));
    },
    async getStop(id) {
      return wrap(await transitland.getStop(access, id));
    },
    async getDepartures(id, min) {
      return wrapRT(await transitland.getDepartures(access, id, min));
    },
    async getRoute(id) {
      return wrap(await transitland.getRoute(access, id));
    },
  });
}
