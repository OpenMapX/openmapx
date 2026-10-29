import { createEnturClient, createEnturGeocoderSources } from "@openmapx/entur-client";
import {
  captureTransitContributors,
  type IntegrationContext,
  resolveIntegrationContributors,
  snapshotContributors,
} from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import { transitDataContributors } from "@openmapx/mobility-core/transit-contributors";
import { createEnturTransitProvider } from "./provider.js";

const NORWAY_BBOX: [number, number, number, number] = [4.0, 57.0, 32.0, 71.5];

export function setup(ctx: IntegrationContext): void {
  const { id, http, upstreamRuntime } = ctx;
  const generation = new AbortController();
  const sourceIds = {
    journeyPlanner: "entur-journey-planner",
    vehicles: "entur-vehicles",
    geocoder: "entur-geocoder",
    nsr: "entur-nsr",
  } as const;
  const isSourceAllowed = async (sourceId: string) => {
    const denied = await ctx.getDisallowedSourceIds?.();
    return !denied?.has(sourceId) && !denied?.has(id);
  };
  const geocoderSources = createEnturGeocoderSources({
    contributors: Object.fromEntries(
      ["entur-geocoder", "entur-geocoder-nsr"]
        .filter((sourceId) =>
          ctx.manifest.dataSources?.some((source) => source.sourceId === sourceId),
        )
        .map((sourceId) => [sourceId, resolveIntegrationContributors(ctx, [sourceId])]),
    ),
    isSourceAllowed,
  });
  const client = createEnturClient({
    http,
    upstreamRuntime,
    config: { ...ctx.config },
    sourceIds,
    contributors: Object.fromEntries(
      Object.values(sourceIds).map((sourceId) => [
        sourceId,
        resolveIntegrationContributors(ctx, [sourceId]),
      ]),
    ),
    isSourceAllowed,
  });
  const entur = createEnturTransitProvider(client, generation.signal, {
    geocoderSources,
    boundaryCountry: ctx.config.boundaryCountry as string | undefined,
    multiModal: ctx.config.multiModal as "parent" | "child" | "all" | undefined,
  });
  ctx.onShutdown(async () => {
    generation.abort(new Error("Entur transit generation retired"));
  });
  const receipts = (ids: readonly string[]) =>
    snapshotContributors(...ids.map((id) => client.contributors[id] ?? []));
  const wrapSource = <T>(data: T, ids: readonly string[], realtime = false) => {
    const captured = captureTransitContributors(data, receipts(ids));
    return withAttribution(
      captured,
      transitDataContributors(captured),
      freshnessNow({ hasRealtimeData: realtime }),
    );
  };
  const wrapRealtimeSource = <T>(data: T, ids: readonly string[]) => wrapSource(data, ids, true);
  const wrap = <T>(data: T) => wrapSource(data, [sourceIds.journeyPlanner]);
  const wrapRT = <T>(data: T) => wrapRealtimeSource(data, [sourceIds.journeyPlanner]);
  ctx.registerHealthCheck(async () => {
    const available = await entur.isEnturTransitAvailable();
    return available
      ? { status: "up" as const }
      : { status: "down" as const, error: "Entur transit API probe failed" };
  });

  ctx.registerTransitProvider({
    id: "transit-entur",
    prefix: "entur:",
    coverage: { bbox: NORWAY_BBOX },
    priority: 1,
    role: "regional",
    attribution: receipts(Object.values(sourceIds)),
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
    async searchStopsByName(query, limit, context) {
      return wrapSource(await entur.searchByName(query, limit ?? 10, context?.signal), [
        "entur-geocoder",
      ]);
    },
    async getStop(stopId) {
      return wrap(await entur.getStop(stopId));
    },
    async getStopInfrastructure(stopId) {
      const data = await entur.getStopInfrastructure(stopId);
      return wrapSource(data ? { ...data, contributors: receipts(["entur-nsr"]) } : data, [
        "entur-nsr",
      ]);
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
          contributors: s.contributors,
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
      return wrapRealtimeSource(await entur.getVehiclePositions(routeId), ["entur-vehicles"]);
    },
    async getVehicleRadar(bbox) {
      return wrapRealtimeSource(await entur.getVehicleRadar(bbox), ["entur-vehicles"]);
    },
    async getVehicleJourney(tripId, fallbackIds) {
      return wrapRT(await entur.getVehicleJourney(tripId, fallbackIds));
    },
    async getFacilities(stopId) {
      return wrapSource(await entur.getFacilities(stopId), ["entur-nsr"]);
    },
  });
}
