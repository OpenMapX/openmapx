import { defineTransitProvider, type IntegrationContext } from "@openmapx/integration-framework";
import * as dbVendo from "./provider.js";

const { attribution, wrap, wrapRT, init } = defineTransitProvider();

export function setup(ctx: IntegrationContext): void {
  init(ctx);
  dbVendo.setDbVendoUserAgent(ctx.config.userAgent as string | undefined);
  ctx.registerTransitProvider({
    id: "transit-db-vendo",
    prefix: "db:",
    coverage: { bbox: [5.87, 47.27, 15.04, 55.06] },
    priority: 6,
    attribution: attribution.all(),
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
      // Arrive-by when an arrival time is given; otherwise plan a departure.
      const arriveBy = params.arrivalTime != null;
      const when = arriveBy ? params.arrivalTime : params.departureTime;
      const date = when?.slice(0, 10) ?? now.toISOString().slice(0, 10);
      const time = when?.slice(11, 19) ?? now.toISOString().slice(11, 19);
      const plan = await dbVendo.planJourney(
        params.from.lat,
        params.from.lng,
        params.to.lat,
        params.to.lng,
        date,
        time,
        arriveBy,
        params.numItineraries,
        { modes: params.modes },
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
