import type { BBox } from "@openmapx/core";
import type {
  IntegrationContext,
  ProviderAttribution,
  TransitProvider,
} from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { Freshness } from "@openmapx/mobility-core/freshness";
import type { MobilityResult } from "@openmapx/mobility-core/result";
import type {
  Departure,
  Facility,
  GeoJSONLineString,
  ServiceAlert,
  TransitRoute,
  TransitStop,
  TransitStopInfrastructure,
  TripPlan,
  VehicleJourney,
  VehiclePosition,
} from "@openmapx/mobility-core/transit";
import { deduplicateStops, isTripNumber } from "./dedup.js";
import { providerHealth } from "./health.js";

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

function freshnessNow(opts?: { hasRealtimeData?: boolean }): Freshness {
  return {
    fetchedAt: new Date().toISOString(),
    hasRealtimeData: opts?.hasRealtimeData ?? false,
    isStale: false,
  };
}

function emptyResult<T>(data: T, opts?: { hasRealtimeData?: boolean }): MobilityResult<T> {
  return { data, attributions: [], freshness: freshnessNow(opts) };
}

/** Returns provider coverage bbox or null when the provider declares global `all:true` coverage. */
function getProviderBbox(p: TransitProvider): BBox | null {
  if ("bbox" in p.coverage) return p.coverage.bbox;
  return null;
}

function providerOverlapsBbox(p: TransitProvider, bbox: BBox): boolean {
  const pBbox = getProviderBbox(p);
  if (!pBbox) return true; // `{ all: true }` matches everywhere
  return bboxesOverlap(bbox, pBbox);
}

/** Merge multiple Attribution[] arrays, deduped by `sourceId`. */
function mergeAttributions(...lists: Attribution[][]): Attribution[] {
  const seen = new Set<string>();
  const out: Attribution[] = [];
  for (const list of lists) {
    for (const a of list) {
      if (seen.has(a.sourceId)) continue;
      seen.add(a.sourceId);
      out.push(a);
    }
  }
  return out;
}

/** Pick the earliest fetchedAt and the strongest realtime/stale signal. */
function mergeFreshness(...lists: Freshness[]): Freshness {
  if (lists.length === 0) return freshnessNow();
  let fetchedAt = lists[0].fetchedAt;
  let hasRealtimeData = false;
  let isStale = false;
  let dataAsOf: string | undefined;
  for (const f of lists) {
    if (f.fetchedAt < fetchedAt) fetchedAt = f.fetchedAt;
    if (f.hasRealtimeData) hasRealtimeData = true;
    if (f.isStale) isStale = true;
    if (f.dataAsOf && (!dataAsOf || f.dataAsOf < dataAsOf)) dataAsOf = f.dataAsOf;
  }
  return { fetchedAt, hasRealtimeData, isStale, ...(dataAsOf ? { dataAsOf } : {}) };
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
      .filter((p) => providerOverlapsBbox(p, bbox))
      .filter((p) => providerHealth.isHealthy(p.id))
      .sort((a, b) => a.priority - b.priority);
  }

  async function getStopsInBbox(
    bbox: BBox,
    modes?: string[],
  ): Promise<MobilityResult<TransitStop[]>> {
    const matching = getProvidersForBbox(bbox).filter((p) => p.getStopsNearby);
    const { lat, lng, radiusMeters } = bboxToCenter(bbox);

    const results = await Promise.allSettled(
      matching.map(async (p) => {
        try {
          if (!p.getStopsNearby) return null;
          const res = await p.getStopsNearby(lat, lng, radiusMeters);
          providerHealth.recordSuccess(p.id);
          return res;
        } catch {
          providerHealth.recordFailure(p.id);
          return null;
        }
      }),
    );

    const ok = results
      .map((r) => (r.status === "fulfilled" ? r.value : null))
      .filter((v): v is MobilityResult<TransitStop[]> => v != null);
    const allStops = ok.flatMap((r) => r.data);

    const deduped = deduplicateStops(allStops, (provider) => getProviderPriority(provider));

    const filtered =
      modes && modes.length > 0
        ? (() => {
            const modeSet = new Set(modes);
            return deduped.filter((s) => s.modes.some((m) => modeSet.has(m)));
          })()
        : deduped;

    return {
      data: filtered,
      attributions: mergeAttributions(...ok.map((r) => r.attributions)),
      freshness: mergeFreshness(...ok.map((r) => r.freshness)),
    };
  }

  async function getDepartures(
    stopId: string,
    minutes: number,
  ): Promise<MobilityResult<Departure[]>> {
    const provider = resolveByPrefix(stopId);
    if (!provider?.getDepartures) return emptyResult<Departure[]>([], { hasRealtimeData: true });
    try {
      const result = await provider.getDepartures(stopId, minutes);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return emptyResult<Departure[]>([], { hasRealtimeData: true });
    }
  }

  async function getArrivals(
    stopId: string,
    minutes: number,
  ): Promise<MobilityResult<Departure[]>> {
    const provider = resolveByPrefix(stopId);
    if (!provider?.getArrivals) return emptyResult<Departure[]>([], { hasRealtimeData: true });
    try {
      const result = await provider.getArrivals(stopId, minutes);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return emptyResult<Departure[]>([], { hasRealtimeData: true });
    }
  }

  async function getStop(stopId: string): Promise<MobilityResult<TransitStop | null>> {
    const provider = resolveByPrefix(stopId);
    if (!provider?.getStop) return emptyResult<TransitStop | null>(null);
    try {
      const result = await provider.getStop(stopId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return emptyResult<TransitStop | null>(null);
    }
  }

  async function searchByName(
    query: string,
    limit: number,
  ): Promise<MobilityResult<TransitStop[]>> {
    const raw = await searchByNameRaw(query, limit);
    const deduped = deduplicateStops(raw.data, (provider) => getProviderPriority(provider)).slice(
      0,
      limit,
    );
    return { data: deduped, attributions: raw.attributions, freshness: raw.freshness };
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
  ): Promise<MobilityResult<TransitStop[]>> {
    const withSearch = (
      bbox
        ? getProvidersForBbox(bbox)
        : collectProviders()
            .filter((p) => providerHealth.isHealthy(p.id))
            .sort((a, b) => a.priority - b.priority)
    ).filter((p) => p.searchStopsByName);

    const results = await Promise.allSettled(
      withSearch.map(async (p) => {
        try {
          if (!p.searchStopsByName) return null;
          const res = await p.searchStopsByName(query, limit);
          providerHealth.recordSuccess(p.id);
          return res;
        } catch {
          providerHealth.recordFailure(p.id);
          return null;
        }
      }),
    );

    const ok = results
      .map((r) => (r.status === "fulfilled" ? r.value : null))
      .filter((v): v is MobilityResult<TransitStop[]> => v != null);

    return {
      data: ok.flatMap((r) => r.data),
      attributions: mergeAttributions(...ok.map((r) => r.attributions)),
      freshness: mergeFreshness(...ok.map((r) => r.freshness)),
    };
  }

  async function planTrip(params: {
    from: { lat: number; lng: number };
    to: { lat: number; lng: number };
    departureTime?: string;
    arrivalTime?: string;
    modes?: string[];
  }): Promise<MobilityResult<TripPlan | null>> {
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
        const res = await provider.planTrip?.(params);
        const first = res?.data?.[0];
        if (first?.itineraries?.length) {
          providerHealth.recordSuccess(provider.id);
          return {
            data: { ...first, provider: first.provider ?? provider.prefix.replace(/:$/, "") },
            attributions: res?.attributions ?? [],
            freshness: res?.freshness ?? freshnessNow(),
          };
        }
      } catch {
        providerHealth.recordFailure(provider.id);
      }
    }
    return emptyResult<TripPlan | null>(null);
  }

  async function getVehicleRadar(bbox: BBox): Promise<MobilityResult<VehiclePosition[]>> {
    const matching = getProvidersForBbox(bbox).filter((p) => p.getVehicleRadar);

    const results = await Promise.allSettled(
      matching.map(async (p) => {
        try {
          if (!p.getVehicleRadar) return null;
          const res = await p.getVehicleRadar(bbox);
          providerHealth.recordSuccess(p.id);
          return res;
        } catch {
          providerHealth.recordFailure(p.id);
          return null;
        }
      }),
    );

    const ok = results
      .map((r) => (r.status === "fulfilled" ? r.value : null))
      .filter((v): v is MobilityResult<VehiclePosition[]> => v != null);

    return {
      data: ok.flatMap((r) => r.data),
      attributions: mergeAttributions(...ok.map((r) => r.attributions)),
      freshness: mergeFreshness(...ok.map((r) => r.freshness)),
    };
  }

  async function getAlerts(bbox: BBox): Promise<MobilityResult<ServiceAlert[]>> {
    const matching = getProvidersForBbox(bbox).filter((p) => p.getAlertsForBbox);

    const results = await Promise.allSettled(
      matching.map(async (p) => {
        try {
          if (!p.getAlertsForBbox) return null;
          const res = await p.getAlertsForBbox(bbox);
          providerHealth.recordSuccess(p.id);
          return res;
        } catch {
          providerHealth.recordFailure(p.id);
          return null;
        }
      }),
    );

    const ok = results
      .map((r) => (r.status === "fulfilled" ? r.value : null))
      .filter((v): v is MobilityResult<ServiceAlert[]> => v != null);

    return {
      data: ok.flatMap((r) => r.data),
      attributions: mergeAttributions(...ok.map((r) => r.attributions)),
      freshness: mergeFreshness(...ok.map((r) => r.freshness)),
    };
  }

  async function getStopPlatforms(stopId: string): Promise<MobilityResult<TransitStop[]>> {
    const provider = resolveByPrefix(stopId);
    if (!provider?.getStopPlatforms) return emptyResult<TransitStop[]>([]);
    try {
      const result = await provider.getStopPlatforms(stopId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return emptyResult<TransitStop[]>([]);
    }
  }

  async function getStopInfrastructure(
    stopId: string,
  ): Promise<MobilityResult<TransitStopInfrastructure | null>> {
    const provider = resolveByPrefix(stopId);
    if (!provider?.getStopInfrastructure)
      return emptyResult<TransitStopInfrastructure | null>(null);
    try {
      const result = await provider.getStopInfrastructure(stopId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return emptyResult<TransitStopInfrastructure | null>(null);
    }
  }

  async function getStopTimetable(
    stopId: string,
    date: string,
  ): Promise<MobilityResult<Departure[]>> {
    const provider = resolveByPrefix(stopId);
    if (!provider?.getStopTimetable) return emptyResult<Departure[]>([]);
    try {
      const result = await provider.getStopTimetable(stopId, date);
      providerHealth.recordSuccess(provider.id);
      // Provider may return TimetableEntry[]; we expose them as Departure[]
      // because every current implementer happens to emit Departure shapes.
      return result as MobilityResult<Departure[]>;
    } catch {
      providerHealth.recordFailure(provider.id);
      return emptyResult<Departure[]>([]);
    }
  }

  async function getRoutesForStop(stopId: string): Promise<MobilityResult<TransitRoute[]>> {
    const provider = resolveByPrefix(stopId);
    if (!provider) return emptyResult<TransitRoute[]>([]);

    // Prefer provider-native route lookup when available.
    if (provider.getRoutesForStop) {
      try {
        const result = await provider.getRoutesForStop(stopId);
        providerHealth.recordSuccess(provider.id);
        // Keep old behavior: if provider route lookup returns nothing, derive
        // routes from departures as a fallback.
        if (result.data.length > 0 || !provider.getDepartures) return result;
      } catch {
        providerHealth.recordFailure(provider.id);
        if (!provider.getDepartures) return emptyResult<TransitRoute[]>([]);
      }
    } else if (!provider.getDepartures) {
      return emptyResult<TransitRoute[]>([]);
    }

    // Compatibility fallback: derive routes from a 12-hour departures window.
    // Several providers expose departures but no route-by-stop endpoint.
    try {
      const depRes = await provider.getDepartures?.(stopId, 720);
      const departures = depRes?.data;
      if (!departures) return emptyResult<TransitRoute[]>([]);
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
      return {
        data: Array.from(byRouteId.values()),
        attributions: depRes?.attributions ?? [],
        freshness: depRes?.freshness ?? freshnessNow(),
      };
    } catch {
      providerHealth.recordFailure(provider.id);
      return emptyResult<TransitRoute[]>([]);
    }
  }

  async function getRoutesInBbox(bbox: BBox): Promise<MobilityResult<TransitRoute[]>> {
    const matching = getProvidersForBbox(bbox).filter((p) => p.getRoutesInBbox);
    const results = await Promise.allSettled(
      matching.map(async (p) => {
        try {
          if (!p.getRoutesInBbox) return null;
          const res = await p.getRoutesInBbox(bbox);
          providerHealth.recordSuccess(p.id);
          return res;
        } catch {
          providerHealth.recordFailure(p.id);
          return null;
        }
      }),
    );
    const ok = results
      .map((r) => (r.status === "fulfilled" ? r.value : null))
      .filter((v): v is MobilityResult<TransitRoute[]> => v != null);
    return {
      data: ok.flatMap((r) => r.data),
      attributions: mergeAttributions(...ok.map((r) => r.attributions)),
      freshness: mergeFreshness(...ok.map((r) => r.freshness)),
    };
  }

  async function getRoute(routeId: string): Promise<MobilityResult<TransitRoute | null>> {
    const provider = resolveByPrefix(routeId);
    if (!provider?.getRoute) return emptyResult<TransitRoute | null>(null);
    try {
      const result = await provider.getRoute(routeId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return emptyResult<TransitRoute | null>(null);
    }
  }

  async function getRouteStops(
    routeId: string,
    hintStopId?: string,
  ): Promise<MobilityResult<TransitStop[]>> {
    const provider = resolveByPrefix(routeId);
    if (!provider) return emptyResult<TransitStop[]>([]);

    if (provider.getRouteStops) {
      try {
        const result = await provider.getRouteStops(routeId, hintStopId);
        providerHealth.recordSuccess(provider.id);
        if (
          result.data.length > 0 ||
          !hintStopId ||
          !provider.getDepartures ||
          !provider.getVehicleJourney
        ) {
          return result;
        }
      } catch {
        providerHealth.recordFailure(provider.id);
        if (!hintStopId || !provider.getDepartures || !provider.getVehicleJourney)
          return emptyResult<TransitStop[]>([]);
      }
    } else if (!hintStopId || !provider.getDepartures || !provider.getVehicleJourney) {
      return emptyResult<TransitStop[]>([]);
    }

    // Compatibility fallback (pre-refactor behavior):
    // derive route stop sequence via a departure trip detail.
    try {
      const depRes = await provider.getDepartures?.(hintStopId as string, 720);
      const departures = depRes?.data;
      if (!departures) return emptyResult<TransitStop[]>([]);
      const dep = departures.find((d) => d.route.id === routeId && !!d.tripId);
      if (!dep?.tripId) return emptyResult<TransitStop[]>([]);
      const journeyRes = await provider.getVehicleJourney?.(dep.tripId);
      const journey = journeyRes?.data ?? null;
      if (
        !journey ||
        typeof journey !== "object" ||
        !Array.isArray((journey as { stops?: unknown[] }).stops)
      ) {
        return emptyResult<TransitStop[]>([]);
      }

      const stops = (
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
      return {
        data: stops,
        attributions: mergeAttributions(depRes?.attributions ?? [], journeyRes?.attributions ?? []),
        freshness: mergeFreshness(
          depRes?.freshness ?? freshnessNow(),
          journeyRes?.freshness ?? freshnessNow(),
        ),
      };
    } catch {
      providerHealth.recordFailure(provider.id);
      return emptyResult<TransitStop[]>([]);
    }
  }

  async function getStopAlerts(stopId: string): Promise<MobilityResult<ServiceAlert[]>> {
    const provider = resolveByPrefix(stopId);
    if (!provider?.getAlertsForStop)
      return emptyResult<ServiceAlert[]>([], { hasRealtimeData: true });
    try {
      const result = await provider.getAlertsForStop(stopId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return emptyResult<ServiceAlert[]>([], { hasRealtimeData: true });
    }
  }

  async function getRouteAlerts(routeId: string): Promise<MobilityResult<ServiceAlert[]>> {
    const provider = resolveByPrefix(routeId);
    if (!provider?.getAlertsForRoute)
      return emptyResult<ServiceAlert[]>([], { hasRealtimeData: true });
    try {
      const result = await provider.getAlertsForRoute(routeId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return emptyResult<ServiceAlert[]>([], { hasRealtimeData: true });
    }
  }

  async function getVehiclePositions(routeId: string): Promise<MobilityResult<VehiclePosition[]>> {
    const provider = resolveByPrefix(routeId);
    if (!provider?.getVehiclePositions)
      return emptyResult<VehiclePosition[]>([], { hasRealtimeData: true });
    try {
      const result = await provider.getVehiclePositions(routeId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return emptyResult<VehiclePosition[]>([], { hasRealtimeData: true });
    }
  }

  async function getLegGeometry(
    tripId: string,
    fromStopId?: string,
    toStopId?: string,
  ): Promise<MobilityResult<GeoJSONLineString | null>> {
    const provider = resolveByPrefix(tripId);
    if (!provider?.getLegGeometry) return emptyResult<GeoJSONLineString | null>(null);
    try {
      const result = await provider.getLegGeometry(tripId, fromStopId, toStopId);
      providerHealth.recordSuccess(provider.id);
      // GeoJSON LineString from the framework's LineString type matches our local
      // GeoJSONLineString shape closely enough (we widen coordinates to
      // [number, number][] at the boundary).
      return result as unknown as MobilityResult<GeoJSONLineString | null>;
    } catch {
      providerHealth.recordFailure(provider.id);
      return emptyResult<GeoJSONLineString | null>(null);
    }
  }

  async function getVehicleJourney(
    vehicleId: string,
    fallbackIds?: string[],
  ): Promise<MobilityResult<VehicleJourney | null>> {
    const provider = resolveByPrefix(vehicleId);
    if (!provider?.getVehicleJourney)
      return emptyResult<VehicleJourney | null>(null, { hasRealtimeData: true });
    try {
      const result = await provider.getVehicleJourney(vehicleId, fallbackIds);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return emptyResult<VehicleJourney | null>(null, { hasRealtimeData: true });
    }
  }

  async function getFacilities(stopId: string): Promise<MobilityResult<Facility[]>> {
    const provider = resolveByPrefix(stopId);
    if (!provider?.getFacilities) return emptyResult<Facility[]>([]);
    try {
      const result = await provider.getFacilities(stopId);
      providerHealth.recordSuccess(provider.id);
      return result;
    } catch {
      providerHealth.recordFailure(provider.id);
      return emptyResult<Facility[]>([]);
    }
  }

  async function getReachableStops(
    lat: number,
    lng: number,
    maxMinutes: number,
    modes?: string[],
  ): Promise<MobilityResult<TransitStop[]>> {
    // Use all healthy providers and merge results
    const allProviders = collectProviders().filter(
      (p) => p.getReachableStops && providerHealth.isHealthy(p.id),
    );

    const results = await Promise.allSettled(
      allProviders.map(async (p) => {
        try {
          if (!p.getReachableStops) return null;
          const res = await p.getReachableStops(lat, lng, maxMinutes, modes);
          providerHealth.recordSuccess(p.id);
          return res;
        } catch {
          providerHealth.recordFailure(p.id);
          return null;
        }
      }),
    );
    const ok = results
      .map((r) => (r.status === "fulfilled" ? r.value : null))
      .filter((v): v is MobilityResult<TransitStop[]> => v != null);
    return {
      data: ok.flatMap((r) => r.data),
      attributions: mergeAttributions(...ok.map((r) => r.attributions)),
      freshness: mergeFreshness(...ok.map((r) => r.freshness)),
    };
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
 * Build a provider attribution map for transit-related integrations.
 *
 * Keys come from three sources:
 *  - For `transit` domain integrations: the provider prefix (`db`, `tfl`,
 *    …) — this is what stop/route ID consumers look up.
 *  - For `gtfs-catalog` domain integrations (e.g. Mobility Database): the
 *    integration id (`transit-mobility-database`). These don't carry an
 *    ID prefix; consumers attributing imported feeds match against
 *    `ImportedFeed.source` instead.
 *  - For providers that expose `getFeedAttribution()`: one row per
 *    runtime feed/instance keyed by what consumers actually carry on
 *    `TransitStop.provider` (e.g. `gtfs-de_vbb`). Lets `transit-gtfs-local`
 *    surface per-feed license without bloating every stop response.
 *
 * Per-feed rows take precedence over the integration-level row because
 * the integration row is the fallback when no instance-level data exists.
 */
export async function getTransitProviderAttribution(
  ctx: IntegrationContext,
): Promise<Record<string, ProviderAttribution>> {
  const result: Record<string, ProviderAttribution> = {};

  const transitIntegrations = ctx.getIntegrationsByDomain("transit");
  const perFeedTasks: Array<Promise<Record<string, ProviderAttribution>>> = [];
  for (const integration of transitIntegrations) {
    const domainProviders = (integration.providers.get("transit") ?? []) as TransitProvider[];
    for (const provider of domainProviders) {
      const prefix = provider.prefix.replace(/:$/, "");
      if (!result[prefix]) {
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
      if (provider.getFeedAttribution) {
        perFeedTasks.push(
          provider.getFeedAttribution().catch((err) => {
            ctx.log.warn(`[transit] getFeedAttribution failed for ${provider.id}:`, err);
            return {};
          }),
        );
      }
    }
  }

  const catalogIntegrations = ctx.getIntegrationsByDomain("gtfs-catalog");
  for (const integration of catalogIntegrations) {
    const ds = integration.manifest.dataSources?.[0];
    if (!ds) continue;
    if (result[integration.id]) continue;
    result[integration.id] = {
      label: ds.name,
      url: ds.url,
      license: ds.license,
      licenseUrl: ds.licenseUrl,
    };
  }

  const perFeedResults = await Promise.all(perFeedTasks);
  for (const map of perFeedResults) {
    for (const [key, value] of Object.entries(map)) {
      // Per-feed rows are instance-specific and always win over
      // integration-level fallbacks keyed by the same string.
      result[key] = value;
    }
  }

  return result;
}
