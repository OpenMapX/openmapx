import {
  defineTransitProvider,
  type IntegrationContext,
  resolveIntegrationContributors,
} from "@openmapx/integration-framework";
import { createSwissTransitClient } from "./client.js";
import { createSwissDatasets } from "./datasets.js";
import { createOpenTransportDataChProvider } from "./provider.js";

const SWITZERLAND_BBOX: [number, number, number, number] = [5.96, 45.82, 10.49, 47.81];

export function setup(ctx: IntegrationContext): void {
  const { attribution, wrap, wrapRT } = defineTransitProvider();
  attribution.set(ctx.manifest.dataSources ?? []);
  const contributors = Object.fromEntries(
    (ctx.manifest.dataSources ?? []).map((source) => [
      source.sourceId,
      resolveIntegrationContributors(ctx, [source.sourceId]),
    ]),
  );
  const isSourceAllowed = async (sourceId: string): Promise<boolean> => {
    const [integrations, sources] = await Promise.all([
      ctx.getDisallowedIntegrationIds?.(),
      ctx.getDisallowedSourceIds?.(),
    ]);
    return !integrations?.has(ctx.manifest.id) && !sources?.has(sourceId);
  };
  const client = createSwissTransitClient({
    config: ctx.config,
    http: ctx.http,
    cache: ctx.cache,
    log: ctx.log,
    upstreamRuntime: ctx.upstreamRuntime,
    contributors,
    isSourceAllowed,
  });
  const datasets = createSwissDatasets({
    http: ctx.http,
    cache: ctx.cache,
    contributors,
    isSourceAllowed,
  });
  const swiss = createOpenTransportDataChProvider({
    client,
    datasets,
    cache: ctx.cache,
    contributors,
    isSourceAllowed,
  });
  ctx.onShutdown(async () => {
    await swiss.dispose();
    await client.dispose();
    await datasets.dispose();
  });
  ctx.registerHealthCheck(async () => {
    const hasKey = client.isSwissTransitConfigured();
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
    role: "regional",
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
    async searchStopsByName(query, limit, context) {
      context?.signal.throwIfAborted();
      const result = await swiss.searchByName(query, limit ?? 10);
      context?.signal.throwIfAborted();
      return wrap(result);
    },
  });
}
