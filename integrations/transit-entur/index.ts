import type { IntegrationContext } from "@openmapx/core";
import * as entur from "./provider.js";

const NORWAY_BBOX: [number, number, number, number] = [4.0, 57.0, 32.0, 71.5];

export function setup(ctx: IntegrationContext): void {
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

  ctx.registerProvider("transit", {
    id: "transit-entur",
    prefix: "entur:",
    coverage: { bbox: NORWAY_BBOX },
    priority: 1,
    capabilities: {
      stops: true,
      departures: true,
      arrivals: true,
      search: true,
      tripPlanning: true,
      alerts: true,
      vehicles: true,
      stopInfrastructure: true,
    },
    getStopsNearby: (lat: number, lng: number, radiusMeters: number) =>
      entur.getStopsNearby(lat, lng, radiusMeters),
    searchByName: (query: string, limit: number) => entur.searchByName(query, limit),
    getStop: (stopId: string) => entur.getStop(stopId),
    getStopInfrastructure: (stopId: string) => entur.getStopInfrastructure(stopId),
    getStopPlatforms: (stopId: string) => entur.getStopPlatforms(stopId),
    getStopTimetable: (stopId: string, date: string) => entur.getStopTimetable(stopId, date),
    getDepartures: (stopId: string, minutes: number) => entur.getDepartures(stopId, minutes),
    getArrivals: (stopId: string, minutes: number) => entur.getArrivals(stopId, minutes),
    getRoutesForStop: (stopId: string) => entur.getRoutesForStop(stopId),
    getRoute: (routeId: string) => entur.getRoute(routeId),
    getRouteStops: (routeId: string, hintStopId?: string) =>
      entur.getRouteStops(routeId, hintStopId),
    planTrip: (params: {
      from: { lat: number; lng: number };
      to: { lat: number; lng: number };
      departureTime?: string;
      arrivalTime?: string;
      modes?: string[];
    }) => entur.planTrip(params),
    getLegGeometry: (tripId: string, fromStopId?: string, toStopId?: string) =>
      entur.getLegGeometry(tripId, fromStopId, toStopId),
    getAlerts: (bbox: [number, number, number, number]) => entur.getAlerts(bbox),
    getStopAlerts: (stopId: string) => entur.getStopAlerts(stopId),
    getRouteAlerts: (routeId: string) => entur.getRouteAlerts(routeId),
    getVehiclePositions: (routeId: string) => entur.getVehiclePositions(routeId),
    getVehicleRadar: (bbox: [number, number, number, number]) => entur.getVehicleRadar(bbox),
    getVehicleJourney: (tripId: string, fallbackIds?: string[]) =>
      entur.getVehicleJourney(tripId, fallbackIds),
    getFacilities: (stopId: string) => entur.getFacilities(stopId),
  });
}
