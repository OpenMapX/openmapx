import type {
  BBox,
  Departure,
  IntegrationContext,
  ServiceAlert,
  TransitRoute,
  TransitStop,
  TransitStopInfrastructure,
  TripPlan,
  VehiclePosition,
} from "@openmapx/core";
import { deduplicateStops, isTripNumber } from "./dedup.js";
import { providerHealth } from "./health.js";
import type { GeoJSONLineString, TransitProvider } from "./types.js";

function bboxesOverlap(a: BBox, b: BBox): boolean {
  return a[2] > b[0] && b[2] > a[0] && a[3] > b[1] && b[3] > a[1];
}

const EARTH_RADIUS = 6_371_000;

export function bboxToCenter(bbox: BBox): { lat: number; lng: number; radiusMeters: number } {
  const [west, south, east, north] = bbox;
  const lat = (south + north) / 2;
  const lng = (west + east) / 2;
  const latDiff = Math.abs(north - south);
  const lngDiff = Math.abs(east - west);
  const latMeters = (latDiff * Math.PI * EARTH_RADIUS) / 180;
  const lngMeters = (lngDiff * Math.PI * EARTH_RADIUS * Math.cos((lat * Math.PI) / 180)) / 180;
  const halfDiag = Math.sqrt(latMeters * latMeters + lngMeters * lngMeters) / 2;
  return { lat, lng, radiusMeters: halfDiag * 1.1 };
}

export function createTransitOrchestrator(ctx: IntegrationContext) {
  /** Lazily collect all transit providers from registered integrations. */
  function collectProviders(): TransitProvider[] {
    const integrations = ctx.getIntegrationsByDomain("transit");
    const providers: TransitProvider[] = [];
    for (const integration of integrations) {
      for (const p of (integration.providers.get("transit") ?? []) as TransitProvider[]) {
        providers.push(p);
      }
    }
    return providers;
  }

  /**
   * Build prefix map sorted by priority (lower = higher priority).
   * First match wins — same as "first registered wins" but via priority.
   */
  function resolveByPrefix(id: string): TransitProvider | null {
    const providers = collectProviders().sort((a, b) => a.priority - b.priority);
    for (const provider of providers) {
      if (id.startsWith(provider.prefix)) return provider;
    }
    return null;
  }

  /** Returns the priority for a provider name (lower = better). Useful for dedup. */
  function getProviderPriority(providerName: string): number {
    for (const p of collectProviders()) {
      if (p.id === providerName || providerName.startsWith(p.prefix.replace(":", "")))
        return p.priority;
    }
    return 100; // unknown providers get low priority
  }

  function getProvidersForBbox(bbox: BBox): TransitProvider[] {
    return collectProviders()
      .filter((p) => bboxesOverlap(bbox, p.coverage.bbox))
      .filter((p) => providerHealth.isHealthy(p.id))
      .sort((a, b) => a.priority - b.priority);
  }

  async function getStopsInBbox(bbox: BBox, modes?: string[]): Promise<TransitStop[]> {
    const matching = getProvidersForBbox(bbox).filter((p) => p.getStopsNearby);
    const { lat, lng, radiusMeters } = bboxToCenter(bbox);

    const results = await Promise.allSettled(
      matching.map(async (p) => {
        try {
          if (!p.getStopsNearby) return [];
          const stops = await p.getStopsNearby(lat, lng, radiusMeters);
          providerHealth.recordSuccess(p.id);
          return stops;
        } catch {
          providerHealth.recordFailure(p.id);
          return [];
        }
      }),
    );

    const allStops = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

    const deduped = deduplicateStops(allStops, (provider) => getProviderPriority(provider));

    if (modes && modes.length > 0) {
      const modeSet = new Set(modes);
      return deduped.filter((s) => s.modes.some((m) => modeSet.has(m)));
    }
    return deduped;
  }

  async function getDepartures(stopId: string, minutes: number): Promise<Departure[]> {
    const provider = resolveByPrefix(stopId);
    if (!provider?.getDepartures) return [];
    try {
      const result = await provider.getDepartures(stopId, minutes);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return [];
    }
  }

  async function getArrivals(stopId: string, minutes: number): Promise<Departure[]> {
    const provider = resolveByPrefix(stopId);
    if (!provider?.getArrivals) return [];
    try {
      const result = await provider.getArrivals(stopId, minutes);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return [];
    }
  }

  async function getStop(stopId: string): Promise<TransitStop | null> {
    const provider = resolveByPrefix(stopId);
    if (!provider?.getStop) return null;
    try {
      const result = await provider.getStop(stopId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return null;
    }
  }

  async function searchByName(query: string, limit: number): Promise<TransitStop[]> {
    const allStops = await searchByNameRaw(query, limit);
    return deduplicateStops(allStops, (provider) => getProviderPriority(provider)).slice(0, limit);
  }

  /**
   * Raw stop-name search without deduplication/truncation.
   * Used by place-linked lookups that need full candidate sets before local
   * distance/name filtering is applied.
   */
  async function searchByNameRaw(
    query: string,
    limit: number,
    bbox?: BBox,
  ): Promise<TransitStop[]> {
    const withSearch = (
      bbox
        ? getProvidersForBbox(bbox)
        : collectProviders()
            .filter((p) => providerHealth.isHealthy(p.id))
            .sort((a, b) => a.priority - b.priority)
    ).filter((p) => p.searchByName);

    const results = await Promise.allSettled(
      withSearch.map(async (p) => {
        try {
          if (!p.searchByName) return [];
          const stops = await p.searchByName(query, limit);
          providerHealth.recordSuccess(p.id);
          return stops;
        } catch {
          providerHealth.recordFailure(p.id);
          return [];
        }
      }),
    );

    return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  async function planTrip(params: {
    from: { lat: number; lng: number };
    to: { lat: number; lng: number };
    departureTime?: string;
    arrivalTime?: string;
    modes?: string[];
  }): Promise<TripPlan | null> {
    const tripBbox: BBox = [
      Math.min(params.from.lng, params.to.lng) - 0.5,
      Math.min(params.from.lat, params.to.lat) - 0.5,
      Math.max(params.from.lng, params.to.lng) + 0.5,
      Math.max(params.from.lat, params.to.lat) + 0.5,
    ];

    const matching = getProvidersForBbox(tripBbox).filter((p) => p.planTrip);

    // Waterfall: try each in priority order, return first success
    for (const provider of matching) {
      try {
        const plan = await provider.planTrip?.(params);
        if (plan?.itineraries?.length) {
          providerHealth.recordSuccess(provider.id);
          return { ...plan, provider: plan.provider ?? provider.prefix.replace(/:$/, "") };
        }
      } catch {
        providerHealth.recordFailure(provider.id);
      }
    }
    return null;
  }

  async function getVehicleRadar(bbox: BBox): Promise<VehiclePosition[]> {
    const matching = getProvidersForBbox(bbox).filter((p) => p.getVehicleRadar);

    const results = await Promise.allSettled(
      matching.map(async (p) => {
        try {
          if (!p.getVehicleRadar) return [];
          const vehicles = await p.getVehicleRadar(bbox);
          providerHealth.recordSuccess(p.id);
          return vehicles;
        } catch {
          providerHealth.recordFailure(p.id);
          return [];
        }
      }),
    );

    return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  async function getAlerts(bbox: BBox): Promise<ServiceAlert[]> {
    const matching = getProvidersForBbox(bbox).filter((p) => p.getAlerts);

    const results = await Promise.allSettled(
      matching.map(async (p) => {
        try {
          if (!p.getAlerts) return [];
          const alerts = await p.getAlerts(bbox);
          providerHealth.recordSuccess(p.id);
          return alerts;
        } catch {
          providerHealth.recordFailure(p.id);
          return [];
        }
      }),
    );

    return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  async function getStopPlatforms(stopId: string): Promise<TransitStop[]> {
    const provider = resolveByPrefix(stopId);
    if (!provider?.getStopPlatforms) return [];
    try {
      const result = await provider.getStopPlatforms(stopId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return [];
    }
  }

  async function getStopInfrastructure(stopId: string): Promise<TransitStopInfrastructure | null> {
    const provider = resolveByPrefix(stopId);
    if (!provider?.getStopInfrastructure) return null;
    try {
      const result = await provider.getStopInfrastructure(stopId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return null;
    }
  }

  async function getStopTimetable(stopId: string, date: string): Promise<Departure[]> {
    const provider = resolveByPrefix(stopId);
    if (!provider?.getStopTimetable) return [];
    try {
      const result = await provider.getStopTimetable(stopId, date);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return [];
    }
  }

  async function getRoutesForStop(stopId: string): Promise<TransitRoute[]> {
    const provider = resolveByPrefix(stopId);
    if (!provider) return [];

    // Prefer provider-native route lookup when available.
    if (provider.getRoutesForStop) {
      try {
        const result = await provider.getRoutesForStop(stopId);
        providerHealth.recordSuccess(provider.id);
        // Keep old behavior: if provider route lookup returns nothing, derive
        // routes from departures as a fallback.
        if (result.length > 0 || !provider.getDepartures) return result;
      } catch {
        providerHealth.recordFailure(provider.id);
        if (!provider.getDepartures) return [];
      }
    } else if (!provider.getDepartures) {
      return [];
    }

    // Compatibility fallback: derive routes from a 12-hour departures window.
    // Several providers expose departures but no route-by-stop endpoint.
    try {
      const departures = await provider.getDepartures?.(stopId, 720);
      if (!departures) return [];
      providerHealth.recordSuccess(provider.id);
      const byRouteId = new Map<string, TransitRoute>();
      for (const dep of departures) {
        if (byRouteId.has(dep.route.id)) continue;
        if (isTripNumber(dep.route.shortName)) continue;
        byRouteId.set(dep.route.id, {
          id: dep.route.id,
          shortName: dep.route.shortName,
          longName: dep.route.longName,
          mode: dep.route.mode,
          color: dep.route.color,
          operatorName: "",
        });
      }
      return Array.from(byRouteId.values());
    } catch {
      providerHealth.recordFailure(provider.id);
      return [];
    }
  }

  async function getRoutesInBbox(bbox: BBox): Promise<TransitRoute[]> {
    const matching = getProvidersForBbox(bbox).filter((p) => p.getRoutesInBbox);
    const results = await Promise.allSettled(
      matching.map(async (p) => {
        try {
          if (!p.getRoutesInBbox) return [];
          const routes = await p.getRoutesInBbox(bbox);
          providerHealth.recordSuccess(p.id);
          return routes;
        } catch {
          providerHealth.recordFailure(p.id);
          return [];
        }
      }),
    );
    return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  async function getRoute(routeId: string): Promise<TransitRoute | null> {
    const provider = resolveByPrefix(routeId);
    if (!provider?.getRoute) return null;
    try {
      const result = await provider.getRoute(routeId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return null;
    }
  }

  async function getRouteStops(routeId: string, hintStopId?: string): Promise<TransitStop[]> {
    const provider = resolveByPrefix(routeId);
    if (!provider) return [];

    if (provider.getRouteStops) {
      try {
        const result = await provider.getRouteStops(routeId, hintStopId);
        providerHealth.recordSuccess(provider.id);
        if (
          result.length > 0 ||
          !hintStopId ||
          !provider.getDepartures ||
          !provider.getVehicleJourney
        ) {
          return result;
        }
      } catch {
        providerHealth.recordFailure(provider.id);
        if (!hintStopId || !provider.getDepartures || !provider.getVehicleJourney) return [];
      }
    } else if (!hintStopId || !provider.getDepartures || !provider.getVehicleJourney) {
      return [];
    }

    // Compatibility fallback (pre-refactor behavior):
    // derive route stop sequence via a departure trip detail.
    try {
      const departures = await provider.getDepartures?.(hintStopId, 720);
      if (!departures) return [];
      const dep = departures.find((d) => d.route.id === routeId && !!d.tripId);
      if (!dep?.tripId) return [];
      const journey = await provider.getVehicleJourney?.(dep.tripId);
      if (
        !journey ||
        typeof journey !== "object" ||
        !Array.isArray((journey as { stops?: unknown[] }).stops)
      ) {
        return [];
      }

      return (
        journey as {
          stops: Array<{
            stopId: string;
            name: string;
            lat: number;
            lng: number;
            platform?: string;
          }>;
        }
      ).stops.map((s, i) => ({
        id: s.stopId,
        name: s.name,
        lat: s.lat,
        lng: s.lng,
        modes: [],
        platformCode: s.platform,
        provider: provider.id,
        sequence: i + 1,
      }));
    } catch {
      providerHealth.recordFailure(provider.id);
      return [];
    }
  }

  async function getStopAlerts(stopId: string): Promise<ServiceAlert[]> {
    const provider = resolveByPrefix(stopId);
    if (!provider?.getStopAlerts) return [];
    try {
      const result = await provider.getStopAlerts(stopId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return [];
    }
  }

  async function getRouteAlerts(routeId: string): Promise<ServiceAlert[]> {
    const provider = resolveByPrefix(routeId);
    if (!provider?.getRouteAlerts) return [];
    try {
      const result = await provider.getRouteAlerts(routeId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return [];
    }
  }

  async function getVehiclePositions(routeId: string): Promise<VehiclePosition[]> {
    const provider = resolveByPrefix(routeId);
    if (!provider?.getVehiclePositions) return [];
    try {
      const result = await provider.getVehiclePositions(routeId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return [];
    }
  }

  async function getLegGeometry(
    tripId: string,
    fromStopId?: string,
    toStopId?: string,
  ): Promise<GeoJSONLineString | null> {
    const provider = resolveByPrefix(tripId);
    if (!provider?.getLegGeometry) return null;
    try {
      const result = await provider.getLegGeometry(tripId, fromStopId, toStopId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return null;
    }
  }

  async function getVehicleJourney(vehicleId: string, fallbackIds?: string[]): Promise<unknown> {
    const provider = resolveByPrefix(vehicleId);
    if (!provider?.getVehicleJourney) return null;
    try {
      const result = await provider.getVehicleJourney(vehicleId, fallbackIds);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return null;
    }
  }

  async function getFacilities(stopId: string): Promise<unknown> {
    const provider = resolveByPrefix(stopId);
    if (!provider?.getFacilities) return null;
    try {
      const result = await provider.getFacilities(stopId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return null;
    }
  }

  async function getReachableStops(
    lat: number,
    lng: number,
    maxMinutes: number,
    modes?: string[],
  ): Promise<TransitStop[]> {
    // Use all healthy providers and merge results
    const allProviders = collectProviders().filter(
      (p) => p.getReachableStops && providerHealth.isHealthy(p.id),
    );

    const results = await Promise.allSettled(
      allProviders.map(async (p) => {
        try {
          if (!p.getReachableStops) return [];
          const stops = await p.getReachableStops(lat, lng, maxMinutes, modes);
          providerHealth.recordSuccess(p.id);
          return stops;
        } catch {
          providerHealth.recordFailure(p.id);
          return [];
        }
      }),
    );
    return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  function getHealthStatus(): Record<string, { healthy: boolean; failures: number }> {
    return providerHealth.getStatus();
  }

  return {
    collectProviders,
    resolveByPrefix,
    getProviderPriority,
    getProvidersForBbox,
    getStopsInBbox,
    getDepartures,
    getArrivals,
    getStop,
    searchByName,
    searchByNameRaw,
    planTrip,
    getVehicleRadar,
    getAlerts,
    getStopPlatforms,
    getStopInfrastructure,
    getStopTimetable,
    getRoutesForStop,
    getRoutesInBbox,
    getRoute,
    getRouteStops,
    getStopAlerts,
    getRouteAlerts,
    getVehiclePositions,
    getLegGeometry,
    getVehicleJourney,
    getFacilities,
    getReachableStops,
    getHealthStatus,
  };
}

export type TransitOrchestrator = ReturnType<typeof createTransitOrchestrator>;

/**
 * Build a provider attribution map from transit integration manifests.
 * Keys are the provider prefixes (e.g. "db", "tfl") extracted from the
 * registered TransitProvider instances; values are attribution data
 * from the integration manifest.
 */
export function getTransitProviderAttribution(
  ctx: IntegrationContext,
): Record<string, { label: string; url: string; license?: string; licenseUrl?: string }> {
  const result: Record<
    string,
    { label: string; url: string; license?: string; licenseUrl?: string }
  > = {};

  const integrations = ctx.getIntegrationsByDomain("transit");
  for (const integration of integrations) {
    const domainProviders = (integration.providers.get("transit") ?? []) as TransitProvider[];
    for (const provider of domainProviders) {
      const prefix = provider.prefix.replace(/:$/, "");
      if (result[prefix]) continue;
      const ds = integration.manifest.dataSources?.[0];
      if (ds) {
        result[prefix] = {
          label: ds.name,
          url: ds.url,
          license: ds.license,
          licenseUrl: ds.licenseUrl,
        };
      }
    }
  }

  return result;
}
