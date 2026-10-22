import {
  captureTransitContributors,
  type IntegrationContext,
  resolveIntegrationContributors,
  snapshotContributors,
} from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import { transitDataContributors } from "@openmapx/mobility-core/transit-contributors";
import { createMbtaClient } from "./client";
import { MbtaError } from "./errors";
import { createMbtaProvider } from "./provider";

export function setup(ctx: IntegrationContext): void {
  const generation = new AbortController();
  const receipts = snapshotContributors(resolveIntegrationContributors(ctx, ["mbta"]));
  const client = createMbtaClient({
    http: ctx.http,
    upstreamRuntime: ctx.upstreamRuntime,
    apiKey: typeof ctx.config.apiKey === "string" ? ctx.config.apiKey : undefined,
    signal: generation.signal,
    isSourceAllowed: async () => {
      const denied = await ctx.getDisallowedSourceIds?.();
      return !denied?.has("mbta") && !denied?.has(ctx.id);
    },
  });
  const mbta = createMbtaProvider(client);
  ctx.onShutdown(async () => {
    generation.abort();
  });
  const result = async <T>(acquire: () => Promise<T>, realtime = false) => {
    const captured = snapshotContributors(receipts);
    const data = await acquire();
    if (generation.signal.aborted) throw new MbtaError("cancelled");
    if (client.configured) await client.assertAvailable();
    if (generation.signal.aborted) throw new MbtaError("cancelled");
    const credited = captureTransitContributors(data, captured);
    return withAttribution(
      credited,
      transitDataContributors(credited),
      freshnessNow({ hasRealtimeData: realtime }),
    );
  };
  const wrap = <T>(acquire: () => Promise<T>) => result(acquire);
  const wrapRT = <T>(acquire: () => Promise<T>) => result(acquire, true);
  ctx.registerHealthCheck(async () => {
    if (generation.signal.aborted) return { status: "down", error: "MBTA instance retired" };
    if (!client.configured) return { status: "unconfigured", error: "MBTA API key not configured" };
    try {
      await mbta.probe();
      if (generation.signal.aborted) throw new MbtaError("cancelled");
      return { status: "up" };
    } catch (error) {
      return {
        status: "down",
        error: error instanceof MbtaError ? error.message : "MBTA probe failed",
      };
    }
  });
  ctx.registerTransitProvider({
    id: "transit-mbta",
    prefix: "mb:",
    coverage: { bbox: [-71.9, 41.3, -69.9, 42.9] },
    priority: 1,
    role: "enrichment",
    attribution: receipts,
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
      return wrap(() => mbta.getStops(lat, lng, radiusMeters));
    },
    async getStop(id) {
      return wrap(() => mbta.getStop(id));
    },
    async getDepartures(id, min) {
      return wrapRT(() => mbta.getDepartures(id, min));
    },
    async getVehiclePositions(routeId) {
      return wrapRT(() => mbta.getVehiclePositions(routeId));
    },
    async getFacilities(stopId) {
      return wrap(() => mbta.getFacilities(stopId));
    },
    async getAlertsForStop(stopId) {
      return wrapRT(() => mbta.getAlerts({ stopId }));
    },
    async getAlertsForRoute(routeId) {
      return wrapRT(() => mbta.getAlerts({ routeId }));
    },
  });
}
