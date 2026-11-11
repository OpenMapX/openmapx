import {
  defineTransitProvider,
  type IntegrationContext,
  isTransitModeRestriction,
} from "@openmapx/integration-framework";
import * as irail from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  const { attribution, wrap, wrapRT } = defineTransitProvider(ctx);
  ctx.registerTransitProvider({
    id: "transit-irail",
    prefix: "ir:",
    coverage: { bbox: [2.54, 49.49, 5.92, 51.51] },
    priority: 1,
    role: "regional",
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
    async searchStopsByName(query, limit, context) {
      return wrap(await irail.searchByName(query, limit ?? 10, context?.signal));
    },
    async getVehicleJourney(vehicleId) {
      return wrapRT(await irail.getVehicleJourney(vehicleId));
    },
    async planTrip(params) {
      // iRail is rail-only with no mode filter on its API, so it can't enforce a
      // mode allow-list — defer to a provider that can when one is requested.
      if (isTransitModeRestriction(params.modes)) return wrapRT([]);
      const arriveBy = params.arrivalTime != null;
      const when = arriveBy ? params.arrivalTime : params.departureTime;
      const { date, time } = irail.brusselsWallClock(when ? new Date(when) : new Date());
      const plan = await irail.planConnections(
        params.from.lat,
        params.from.lng,
        params.to.lat,
        params.to.lng,
        date,
        time,
        arriveBy,
        params.numItineraries,
      );
      return wrapRT(plan ? [plan] : []);
    },
  });
}
