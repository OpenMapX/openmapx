import { defineTransitProvider, type IntegrationContext } from "@openmapx/integration-framework";
import * as entur from "./provider.js";

const NORWAY_BBOX: [number, number, number, number] = [4.0, 57.0, 32.0, 71.5];

const { attribution, wrap, wrapRT, init } = defineTransitProvider();

export function setup(ctx: IntegrationContext): void {
  init(ctx);
  entur.setEnturTransitConfig({
    geocoderEndpoint: ctx.config.geocoderEndpoint as string | undefined,
    journeyPlannerEndpoint: ctx.config.journeyPlannerEndpoint as string | undefined,
    vehiclesEndpoint: ctx.config.vehiclesEndpoint as string | undefined,
    nsrEndpoint: ctx.config.nsrEndpoint as string | undefined,
    clientName: ctx.config.clientName as string | undefined,
    boundaryCountry: ctx.config.boundaryCountry as string | undefined,
    multiModal: ctx.config.multiModal as "parent" | "child" | "all" | undefined,
  });

  ctx.registerHealthCheck(async () => {
    const available = await entur.isEnturTransitAvailable();
    return available
      ? { status: "up" as const }
      : { status: "down" as const, error: "Journey Planner probe failed" };
  });

  ctx.registerTransitProvider({
    id: "transit-entur",
    prefix: "entur:",
    coverage: { bbox: NORWAY_BBOX },
    priority: 1,
    attribution: attribution.all(),
    capabilities: {
      stops: {
        lookup: true,
        nearby: true,
        bbox: false,
        search: true,
        infrastructure: true,
        platforms: true,
        timetable: true,
      },
      departures: true,
      arrivals: true,
      routes: { lookup: true, forStop: true, stops: true, geometry: true },
      planning: true,
      vehiclePositions: true,
      vehicleJourney: true,
      alerts: { byStop: true, byRoute: true, byBbox: true },
      facilities: true,
    },
    async getStopsNearby(lat, lng, radiusMeters) {
      return wrap(await entur.getStopsNearby(lat, lng, radiusMeters));
    },
    async searchStopsByName(query, limit) {
      return wrap(await entur.searchByName(query, limit ?? 10));
    },
    async getStop(stopId) {
      return wrap(await entur.getStop(stopId));
    },
    async getStopInfrastructure(stopId) {
      return wrap(await entur.getStopInfrastructure(stopId));
    },
    async getStopPlatforms(stopId) {
      return wrap(await entur.getStopPlatforms(stopId));
    },
    async getStopTimetable(stopId, date) {
      return wrap(await entur.getStopTimetable(stopId, date));
    },
    async getDepartures(stopId, minutes) {
      return wrapRT(await entur.getDepartures(stopId, minutes));
    },
    async getArrivals(stopId, minutes) {
      return wrapRT(await entur.getArrivals(stopId, minutes));
    },
    async getRoutesForStop(stopId) {
      return wrap(await entur.getRoutesForStop(stopId));
    },
    async getRoute(routeId) {
      return wrap(await entur.getRoute(routeId));
    },
    async getRouteStops(routeId, hintStopId) {
      // Entur exposes RouteStop[] (sequence-ordered, no `modes`/`provider`);
      // expand into TransitStop[] so consumers can treat results uniformly.
      const stops = await entur.getRouteStops(routeId, hintStopId);
      return wrap(
        stops.map((s) => ({
          id: s.id,
          name: s.name,
          lat: s.lat,
          lng: s.lng,
          modes: [],
          platformCode: s.platformCode,
          provider: "entur",
          sequence: s.sequence,
        })),
      );
    },
    async planTrip(params) {
      const plan = await entur.planTrip(params);
      return wrapRT(plan ? [plan] : []);
    },
    async getLegGeometry(tripId, fromStopId, toStopId) {
      return wrap(await entur.getLegGeometry(tripId, fromStopId, toStopId));
    },
    async getAlertsForBbox(bbox) {
      return wrapRT(await entur.getAlerts(bbox));
    },
    async getAlertsForStop(stopId) {
      return wrapRT(await entur.getStopAlerts(stopId));
    },
    async getAlertsForRoute(routeId) {
      return wrapRT(await entur.getRouteAlerts(routeId));
    },
    async getVehiclePositions(routeId) {
      return wrapRT(await entur.getVehiclePositions(routeId));
    },
    async getVehicleRadar(bbox) {
      return wrapRT(await entur.getVehicleRadar(bbox));
    },
    async getVehicleJourney(tripId, fallbackIds) {
      return wrapRT(await entur.getVehicleJourney(tripId, fallbackIds));
    },
    async getFacilities(stopId) {
      return wrap(await entur.getFacilities(stopId));
    },
  });
}
