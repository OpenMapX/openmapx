import { defineTransitProvider, type IntegrationContext } from "@openmapx/integration-framework";
import * as mbta from "./provider.js";

const { attribution, wrap, wrapRT, init } = defineTransitProvider();

export function setup(ctx: IntegrationContext): void {
  init(ctx);
  ctx.onActivate(() => mbta.setMbtaApiKey(ctx.config.apiKey as string | undefined));
  ctx.registerTransitProvider({
    id: "transit-mbta",
    prefix: "mb:",
    coverage: { bbox: [-71.9, 41.3, -69.9, 42.9] },
    priority: 1,
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
      routes: { lookup: false, forStop: false, stops: false, geometry: false },
      planning: false,
      vehiclePositions: true,
      vehicleJourney: false,
      alerts: { byStop: true, byRoute: true, byBbox: false },
      facilities: true,
    },
    async getStopsNearby(lat, lng, radiusMeters) {
      return wrap(await mbta.getStops(lat, lng, radiusMeters));
    },
    async getStop(id) {
      return wrap(await mbta.getStop(id));
    },
    async getDepartures(id, min) {
      return wrapRT(await mbta.getDepartures(id, min));
    },
    async getVehiclePositions(routeId) {
      return wrapRT(await mbta.getVehiclePositions(routeId));
    },
    async getFacilities(stopId) {
      return wrap(await mbta.getFacilities(stopId));
    },
    async getAlertsForStop(stopId) {
      return wrapRT(await mbta.getAlerts({ stopId }));
    },
    async getAlertsForRoute(routeId) {
      return wrapRT(await mbta.getAlerts({ routeId }));
    },
  });
}
