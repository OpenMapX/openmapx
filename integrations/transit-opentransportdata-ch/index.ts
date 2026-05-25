import {
  createManifestAttribution,
  type IntegrationContext,
} from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import * as swiss from "./provider.js";

const SWITZERLAND_BBOX: [number, number, number, number] = [5.96, 45.82, 10.49, 47.81];

const attribution = createManifestAttribution();
const wrap = <T>(data: T) => withAttribution(data, attribution.all(), freshnessNow());
const wrapRT = <T>(data: T) =>
  withAttribution(data, attribution.all(), freshnessNow({ hasRealtimeData: true }));

export function setup(ctx: IntegrationContext): void {
  attribution.set(ctx.manifest.dataSources ?? []);
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

  ctx.registerTransitProvider({
    id: "transit-opentransportdata-ch",
    prefix: "otdch:",
    priority: 1,
    coverage: { bbox: SWITZERLAND_BBOX },
    attribution: attribution.all(),
    capabilities: {
      stops: {
        lookup: true,
        nearby: true,
        bbox: false,
        search: true,
        infrastructure: true,
        platforms: true,
        timetable: false,
      },
      departures: true,
      arrivals: true,
      routes: { lookup: true, forStop: true, stops: true, geometry: true },
      planning: true,
      vehiclePositions: false,
      vehicleJourney: true,
      alerts: { byStop: true, byRoute: true, byBbox: true },
      facilities: false,
    },
    async getAlertsForBbox(bbox) {
      return wrapRT(await swiss.getAlerts(bbox));
    },
    async getArrivals(stopId, minutes) {
      return wrapRT(await swiss.getArrivals(stopId, minutes));
    },
    async getDepartures(stopId, minutes) {
      return wrapRT(await swiss.getDepartures(stopId, minutes));
    },
    async getLegGeometry(tripId, fromStopId, toStopId) {
      return wrap(await swiss.getLegGeometry(tripId, fromStopId, toStopId));
    },
    async getRoute(routeId) {
      return wrap(await swiss.getRoute(routeId));
    },
    async getRoutesForStop(stopId) {
      return wrap(await swiss.getRoutesForStop(stopId));
    },
    async getRouteStops(routeId, hintStopId) {
      return wrap(await swiss.getRouteStops(routeId, hintStopId));
    },
    async getStop(stopId) {
      return wrap(await swiss.getStop(stopId));
    },
    async getAlertsForStop(stopId) {
      return wrapRT(await swiss.getStopAlerts(stopId));
    },
    async getStopInfrastructure(stopId) {
      return wrap(await swiss.getStopInfrastructure(stopId));
    },
    async getStopPlatforms(stopId) {
      return wrap(await swiss.getStopPlatforms(stopId));
    },
    async getStopsNearby(lat, lng, radiusMeters) {
      return wrap(await swiss.getStopsNearby(lat, lng, radiusMeters));
    },
    async getVehicleJourney(tripId, fallbackIds) {
      return wrapRT(await swiss.getVehicleJourney(tripId, fallbackIds));
    },
    async getAlertsForRoute(routeId) {
      return wrapRT(await swiss.getRouteAlerts(routeId));
    },
    async planTrip(params) {
      const plan = await swiss.planTrip(params);
      return wrapRT(plan ? [plan] : []);
    },
    async searchStopsByName(query, limit) {
      return wrap(await swiss.searchByName(query, limit ?? 10));
    },
  });
}
