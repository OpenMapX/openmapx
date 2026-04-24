import type { IntegrationContext } from "@openmapx/core";
import * as swiss from "./provider.js";

const SWITZERLAND_BBOX: [number, number, number, number] = [5.96, 45.82, 10.49, 47.81];

export function setup(ctx: IntegrationContext): void {
  swiss.setOpenTransportDataChConfig({
    apiKey: ctx.config.apiKey as string | undefined,
    cache: ctx.cache,
    fallbackEndpoint: ctx.config.fallbackEndpoint as string | undefined,
    formationEndpoint: ctx.config.formationEndpoint as string | undefined,
    gtfsRtEndpoint: ctx.config.gtfsRtEndpoint as string | undefined,
    gtfsSaEndpoint: ctx.config.gtfsSaEndpoint as string | undefined,
    log: ctx.log,
    ojpEndpoint: ctx.config.ojpEndpoint as string | undefined,
    ojpFareEndpoint: ctx.config.ojpFareEndpoint as string | undefined,
    requestLanguage: ctx.config.requestLanguage as string | undefined,
    requestorRef: ctx.config.requestorRef as string | undefined,
    siriSxEndpoint: ctx.config.siriSxEndpoint as string | undefined,
    siriSxUnplannedEndpoint: ctx.config.siriSxUnplannedEndpoint as string | undefined,
    userAgent: ctx.config.userAgent as string | undefined,
  });
  swiss.setSwissGtfsDeps(
    (ctx.config.swissGtfsDeps as Parameters<typeof swiss.setSwissGtfsDeps>[0] | undefined) ?? null,
  );

  ctx.registerHealthCheck(async () => {
    const hasKey = Boolean((ctx.config.apiKey as string | undefined)?.trim());
    if (!hasKey) {
      return { status: "unconfigured" as const, error: "Swiss API key not configured" };
    }
    const available = await swiss.isOpenTransportDataChAvailable();
    return available
      ? { status: "up" as const }
      : { status: "down" as const, error: "Swiss OJP probe failed" };
  });

  ctx.registerProvider("transit", {
    capabilities: {
      alerts: true,
      arrivals: true,
      departures: true,
      search: true,
      stopInfrastructure: true,
      stops: true,
      tripPlanning: true,
      vehicles: false,
    },
    coverage: { bbox: SWITZERLAND_BBOX },
    getAlerts: (bbox: [number, number, number, number]) => swiss.getAlerts(bbox),
    getArrivals: (stopId: string, minutes: number) => swiss.getArrivals(stopId, minutes),
    getDepartures: (stopId: string, minutes: number) => swiss.getDepartures(stopId, minutes),
    getLegGeometry: (tripId: string, fromStopId?: string, toStopId?: string) =>
      swiss.getLegGeometry(tripId, fromStopId, toStopId),
    getRoute: (routeId: string) => swiss.getRoute(routeId),
    getRoutesForStop: (stopId: string) => swiss.getRoutesForStop(stopId),
    getRouteStops: (routeId: string, hintStopId?: string) =>
      swiss.getRouteStops(routeId, hintStopId),
    getStop: (stopId: string) => swiss.getStop(stopId),
    getStopAlerts: (stopId: string) => swiss.getStopAlerts(stopId),
    getStopInfrastructure: (stopId: string) => swiss.getStopInfrastructure(stopId),
    getStopPlatforms: (stopId: string) => swiss.getStopPlatforms(stopId),
    getStopsNearby: (lat: number, lng: number, radiusMeters: number) =>
      swiss.getStopsNearby(lat, lng, radiusMeters),
    getVehicleJourney: (tripId: string, fallbackIds?: string[]) =>
      swiss.getVehicleJourney(tripId, fallbackIds),
    getRouteAlerts: (routeId: string) => swiss.getRouteAlerts(routeId),
    id: "transit-opentransportdata-ch",
    planTrip: (params: {
      from: { lat: number; lng: number };
      to: { lat: number; lng: number };
      departureTime?: string;
      arrivalTime?: string;
      modes?: string[];
    }) => swiss.planTrip(params),
    prefix: "otdch:",
    priority: 1,
    searchByName: (query: string, limit: number) => swiss.searchByName(query, limit),
  });
}
