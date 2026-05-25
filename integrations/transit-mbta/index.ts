import {
  createManifestAttribution,
  type IntegrationContext,
} from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import * as mbta from "./provider.js";

const attribution = createManifestAttribution();
const wrap = <T>(data: T) => withAttribution(data, attribution.all(), freshnessNow());
const wrapRT = <T>(data: T) =>
  withAttribution(data, attribution.all(), freshnessNow({ hasRealtimeData: true }));

export function setup(ctx: IntegrationContext): void {
  attribution.set(ctx.manifest.dataSources ?? []);
  mbta.setMbtaApiKey(ctx.config.apiKey as string | undefined);
  ctx.registerTransitProvider({
    id: "transit-mbta",
    prefix: "mb:",
    coverage: { bbox: [-71.9, 41.3, -69.9, 42.9] },
    priority: 1,
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
