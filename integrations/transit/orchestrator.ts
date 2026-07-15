import type { BBox } from "@openmapx/core";
import type {
  IntegrationContext,
  MetricsRecorder,
  ProviderCallOutcome,
  ProviderHealthHandle,
  TransitProvider,
  TripPlanRequest,
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
import { enrichDeparturesWithRealtime } from "./realtime.js";

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

export class UnsupportedTransitPlanningCapabilitiesError extends Error {
  constructor(readonly capabilities: string[]) {
    super(`No transit planner supports: ${capabilities.join(", ")}`);
    this.name = "UnsupportedTransitPlanningCapabilitiesError";
  }
}

export function requiredPlanningCapabilities(request: TripPlanRequest): string[] {
  const required: string[] = [];
  if (request.maxTransfers !== undefined) required.push("maxTransfers");
  if (request.transferBuffer && request.transferBuffer !== "standard") {
    required.push("transferBuffer");
  }
  if (request.wheelchairRequired || request.wheelchair) required.push("wheelchairRequired");
  if (request.requireBikeTransport) required.push("bikeTransport");
  if (request.bikeHillPreference && request.bikeHillPreference !== "default") {
    required.push("elevation");
  }
  if (request.rentalFilters) required.push("rentalFilters");
  if (request.pageCursor) required.push("paging");
  return required;
}

function supportsPlanningRequest(provider: TransitProvider, required: string[]): boolean {
  if (required.length === 0) return true;
  const features = provider.capabilities.planningFeatures;
  return required.every((capability) => features?.[capability as keyof typeof features] === true);
}

/**
 * Merge multiple Attribution[] arrays, deduped by `sourceId`.
 *
 * When the host has provided an AttributionIndex on the IntegrationContext, we
 * delegate the merge to `ctx.attributionIndex.dedupAndOrder`, which:
 *
 *   - resolves each sourceId against MOTIS license.json + integration manifest
 *     dataSources (so the curated row replaces the caller-supplied stub);
 *   - groups integration-manifest entries before motis-license entries;
 *   - sorts alphabetically within each group for stable output.
 *
 * Without an index, this falls back to the original dedup-only behaviour so
 * orchestrators wired up before F1+F2 keep working unchanged.
 */
function mergeAttributions(
  index: { dedupAndOrder(attrs: Attribution[]): Attribution[] } | undefined,
  ...lists: Attribution[][]
): Attribution[] {
  if (index) {
    const all: Attribution[] = [];
    for (const list of lists) {
      for (const a of list) all.push(a);
    }
    return index.dedupAndOrder(all);
  }
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

/**
 * Keep only the fan-out results that actually returned data, for building
 * attribution lists. Providers are queried broadly (by prefix/coverage), so the
 * raw result set includes providers that matched the area but returned nothing —
 * e.g. the per-operator dynamic-registry providers that don't serve the place.
 * Crediting those would attribute data they never contributed.
 */
function resultsWithData<T>(results: MobilityResult<T[]>[]): MobilityResult<T[]>[] {
  return results.filter((r) => r.data.length > 0);
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

/**
 * Local fallback when the host doesn't wire a ProviderHealthHandle (e.g.
 * tests, dev scripts). Treats every provider as healthy; success/failure
 * records are dropped on the floor.
 */
const noopHealth: ProviderHealthHandle = {
  isHealthy: () => Promise.resolve(true),
  recordSuccess: () => Promise.resolve(),
  recordFailure: () => Promise.resolve(),
};

const noopMetrics: MetricsRecorder = {
  recordProviderCall: () => {},
};

function failureReason(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Determine the call outcome from the returned value. `"ok"` when the value
 * is a non-empty, non-null result; `"empty"` when the call succeeded but
 * returned `null`, `undefined`, an empty array, or an empty object whose
 * `data` key is itself empty. Used by `timed()` so OTEL counters distinguish
 * a provider that successfully reported "no data" from one that returned
 * actual content.
 */
function classifyOutcome(value: unknown): ProviderCallOutcome {
  if (value === null || value === undefined) return "empty";
  if (Array.isArray(value)) return value.length === 0 ? "empty" : "ok";
  if (typeof value === "object") {
    const obj = value as { data?: unknown };
    if ("data" in obj) {
      const data = obj.data;
      if (data === null || data === undefined) return "empty";
      if (Array.isArray(data)) return data.length === 0 ? "empty" : "ok";
    }
  }
  return "ok";
}

/**
 * Wraps a provider call with latency timing + health tracking + OTEL metrics.
 * The provider's existing fallback semantics (catch + return null/empty) stay
 * identical; this helper just feeds success/failure + latency into the
 * health tracker and emits a `transit_provider_calls_total` increment plus
 * a `transit_provider_call_duration_ms` observation with the same labels
 * (G3 wiring).
 */
async function timed<T>(
  health: ProviderHealthHandle,
  metrics: MetricsRecorder,
  providerId: string,
  method: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  const start = performance.now();
  try {
    const value = await fn();
    const elapsed = performance.now() - start;
    await health.recordSuccess(providerId, elapsed);
    metrics.recordProviderCall({ providerId, method, outcome: classifyOutcome(value) }, elapsed);
    return { ok: true, value };
  } catch (error) {
    const elapsed = performance.now() - start;
    await health.recordFailure(providerId, elapsed, failureReason(error));
    metrics.recordProviderCall({ providerId, method, outcome: "error" }, elapsed);
    return { ok: false, error };
  }
}

export function createTransitOrchestrator(ctx: IntegrationContext) {
  const providerHealth: ProviderHealthHandle = ctx.providerHealth ?? noopHealth;
  const metricsRecorder: MetricsRecorder = ctx.metricsRecorder ?? noopMetrics;

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
   * Provider ids whose backing data source the operator's data-use policy
   * disallows. A transit provider's `id` (e.g. `db`, `dyn:at/oebb…`) is not its
   * manifest `sourceId`, and transit result items carry `provider` (the prefix),
   * not a `source` the per-item response filter could strip — so we map gated
   * sources to the providers their integration registered and skip those in
   * dispatch, falling back to the next provider.
   *
   * An integration's transit providers are gated when ANY of its declared sources
   * is disallowed. For single-source transit integrations that equals full
   * gating; it additionally covers the dynamic registry, whose grey-area
   * `regional-operators` source backs every provider it registers while its other
   * sources (the JSDelivr/GitHub catalog fetch) stay allowed — without this an
   * operator who disables grey-area sources would keep querying those operators,
   * contrary to the toggle's stated effect. Where no allowed provider covers the
   * region the result is empty, the intended effect of the policy. Returns an
   * empty set (no filtering) when the policy permits everything.
   */
  async function disallowedProviderIds(): Promise<Set<string>> {
    const disallowedSources = (await ctx.getDisallowedSourceIds?.()) ?? new Set<string>();
    if (disallowedSources.size === 0) return new Set<string>();
    const ids = new Set<string>();
    for (const integration of ctx.getIntegrationsByDomain("transit")) {
      const sources = integration.manifest.dataSources ?? [];
      if (!sources.some((ds) => disallowedSources.has(ds.sourceId))) continue;
      for (const p of (integration.providers.get("transit") ?? []) as TransitProvider[]) {
        ids.add(p.id);
      }
    }
    return ids;
  }

  /**
   * Build prefix map sorted by priority (lower = higher priority) and return
   * the first provider that both matches the id's prefix AND is currently
   * healthy. When the highest-priority match is in cooldown but another
   * provider shares the same prefix, we fall through to it — today most
   * prefixes are unique to a single provider so the fallback is rare, but
   * the iteration costs nothing and keeps the contract correct as new
   * providers come online.
   *
   * Returns `null` when no healthy provider matches. Callers translate that
   * into an empty `MobilityResult`, which is preferable to hammering a
   * known-disabled upstream and stretching its cooldown (G1 / plan §4.9).
   */
  async function resolveByPrefix(id: string): Promise<TransitProvider | null> {
    const banned = await disallowedProviderIds();
    const providers = collectProviders().sort((a, b) => a.priority - b.priority);
    for (const provider of providers) {
      if (!id.startsWith(provider.prefix)) continue;
      if (banned.has(provider.id)) continue;
      if (await providerHealth.isHealthy(provider.id)) return provider;
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

  async function filterHealthy(providers: TransitProvider[]): Promise<TransitProvider[]> {
    const banned = await disallowedProviderIds();
    const allowed = banned.size === 0 ? providers : providers.filter((p) => !banned.has(p.id));
    const checks = await Promise.all(allowed.map((p) => providerHealth.isHealthy(p.id)));
    return allowed.filter((_, i) => checks[i]);
  }

  async function getProvidersForBbox(bbox: BBox): Promise<TransitProvider[]> {
    const overlapping = collectProviders()
      .filter((p) => providerOverlapsBbox(p, bbox))
      .sort((a, b) => a.priority - b.priority);
    return filterHealthy(overlapping);
  }

  async function getStopsInBbox(
    bbox: BBox,
    modes?: string[],
  ): Promise<MobilityResult<TransitStop[]>> {
    const matching = (await getProvidersForBbox(bbox)).filter((p) => p.getStopsNearby);
    const { lat, lng, radiusMeters } = bboxToCenter(bbox);

    const results = await Promise.allSettled(
      matching.map(async (p) => {
        if (!p.getStopsNearby) return null;
        const fn = p.getStopsNearby.bind(p);
        const outcome = await timed(providerHealth, metricsRecorder, p.id, "getStopsInBbox", () =>
          fn(lat, lng, radiusMeters),
        );
        return outcome.ok ? outcome.value : null;
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
      attributions: mergeAttributions(
        ctx.attributionIndex,
        ...resultsWithData(ok).map((r) => r.attributions),
      ),
      freshness: mergeFreshness(...ok.map((r) => r.freshness)),
    };
  }

  // Bound `timed` for realtime-enrichment fan-out so its calls share the
  // same health-tracking + OTEL recorder path as the orchestrator's own
  // provider calls (G3 telemetry wiring).
  const boundTimed = <T>(providerId: string, method: string, fn: () => Promise<T>) =>
    timed(providerHealth, metricsRecorder, providerId, method, fn);

  async function getDepartures(
    stopId: string,
    minutes: number,
  ): Promise<MobilityResult<Departure[]>> {
    const provider = await resolveByPrefix(stopId);
    if (!provider?.getDepartures) return emptyResult<Departure[]>([], { hasRealtimeData: true });
    const fn = provider.getDepartures.bind(provider);
    const outcome = await timed(providerHealth, metricsRecorder, provider.id, "getDepartures", () =>
      fn(stopId, minutes),
    );
    const base = outcome.ok
      ? outcome.value
      : emptyResult<Departure[]>([], { hasRealtimeData: true });
    return enrichDeparturesWithRealtime({ ctx, timed: boundTimed }, base, { stopId });
  }

  async function getArrivals(
    stopId: string,
    minutes: number,
  ): Promise<MobilityResult<Departure[]>> {
    const provider = await resolveByPrefix(stopId);
    if (!provider?.getArrivals) return emptyResult<Departure[]>([], { hasRealtimeData: true });
    const fn = provider.getArrivals.bind(provider);
    const outcome = await timed(providerHealth, metricsRecorder, provider.id, "getArrivals", () =>
      fn(stopId, minutes),
    );
    const base = outcome.ok
      ? outcome.value
      : emptyResult<Departure[]>([], { hasRealtimeData: true });
    return enrichDeparturesWithRealtime({ ctx, timed: boundTimed }, base, { stopId });
  }

  async function getStop(stopId: string): Promise<MobilityResult<TransitStop | null>> {
    const provider = await resolveByPrefix(stopId);
    if (!provider?.getStop) return emptyResult<TransitStop | null>(null);
    const fn = provider.getStop.bind(provider);
    const outcome = await timed(providerHealth, metricsRecorder, provider.id, "getStop", () =>
      fn(stopId),
    );
    return outcome.ok ? outcome.value : emptyResult<TransitStop | null>(null);
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
    const baseProviders = bbox
      ? await getProvidersForBbox(bbox)
      : await filterHealthy(collectProviders().sort((a, b) => a.priority - b.priority));
    const withSearch = baseProviders.filter((p) => p.searchStopsByName);

    const results = await Promise.allSettled(
      withSearch.map(async (p) => {
        if (!p.searchStopsByName) return null;
        const fn = p.searchStopsByName.bind(p);
        const outcome = await timed(
          providerHealth,
          metricsRecorder,
          p.id,
          "searchStopsByName",
          () => fn(query, limit),
        );
        return outcome.ok ? outcome.value : null;
      }),
    );

    const ok = results
      .map((r) => (r.status === "fulfilled" ? r.value : null))
      .filter((v): v is MobilityResult<TransitStop[]> => v != null);

    return {
      data: ok.flatMap((r) => r.data),
      attributions: mergeAttributions(
        ctx.attributionIndex,
        ...resultsWithData(ok).map((r) => r.attributions),
      ),
      freshness: mergeFreshness(...ok.map((r) => r.freshness)),
    };
  }

  async function planTrip(params: TripPlanRequest): Promise<MobilityResult<TripPlan | null>> {
    const tripBbox: BBox = [
      Math.min(params.from.lng, params.to.lng) - 0.5,
      Math.min(params.from.lat, params.to.lat) - 0.5,
      Math.max(params.from.lng, params.to.lng) + 0.5,
      Math.max(params.from.lat, params.to.lat) + 0.5,
    ];

    const matching = (await getProvidersForBbox(tripBbox)).filter((p) => p.planTrip);
    const required = requiredPlanningCapabilities(params);
    const eligible = matching.filter((provider) => supportsPlanningRequest(provider, required));
    if (matching.length > 0 && eligible.length === 0 && required.length > 0) {
      throw new UnsupportedTransitPlanningCapabilitiesError(required);
    }

    // Waterfall: try each in priority order, return first success
    for (const provider of eligible) {
      const planFn = provider.planTrip;
      if (!planFn) continue;
      const bound = planFn.bind(provider);
      const outcome = await timed(providerHealth, metricsRecorder, provider.id, "planTrip", () =>
        bound(params),
      );
      if (!outcome.ok) continue;
      const res = outcome.value;
      const first = res?.data?.[0];
      if (first?.itineraries?.length) {
        return {
          data: { ...first, provider: first.provider ?? provider.prefix.replace(/:$/, "") },
          attributions: res?.attributions ?? [],
          freshness: res?.freshness ?? freshnessNow(),
        };
      }
    }
    return emptyResult<TripPlan | null>(null);
  }

  async function getVehicleRadar(bbox: BBox): Promise<MobilityResult<VehiclePosition[]>> {
    const matching = (await getProvidersForBbox(bbox)).filter((p) => p.getVehicleRadar);

    const results = await Promise.allSettled(
      matching.map(async (p) => {
        if (!p.getVehicleRadar) return null;
        const fn = p.getVehicleRadar.bind(p);
        const outcome = await timed(providerHealth, metricsRecorder, p.id, "getVehicleRadar", () =>
          fn(bbox),
        );
        return outcome.ok ? outcome.value : null;
      }),
    );

    const ok = results
      .map((r) => (r.status === "fulfilled" ? r.value : null))
      .filter((v): v is MobilityResult<VehiclePosition[]> => v != null);

    return {
      data: ok.flatMap((r) => r.data),
      attributions: mergeAttributions(
        ctx.attributionIndex,
        ...resultsWithData(ok).map((r) => r.attributions),
      ),
      freshness: mergeFreshness(...ok.map((r) => r.freshness)),
    };
  }

  async function getAlerts(bbox: BBox): Promise<MobilityResult<ServiceAlert[]>> {
    const matching = (await getProvidersForBbox(bbox)).filter((p) => p.getAlertsForBbox);

    const results = await Promise.allSettled(
      matching.map(async (p) => {
        if (!p.getAlertsForBbox) return null;
        const fn = p.getAlertsForBbox.bind(p);
        const outcome = await timed(providerHealth, metricsRecorder, p.id, "getAlertsForBbox", () =>
          fn(bbox),
        );
        return outcome.ok ? outcome.value : null;
      }),
    );

    const ok = results
      .map((r) => (r.status === "fulfilled" ? r.value : null))
      .filter((v): v is MobilityResult<ServiceAlert[]> => v != null);

    return {
      data: ok.flatMap((r) => r.data),
      attributions: mergeAttributions(
        ctx.attributionIndex,
        ...resultsWithData(ok).map((r) => r.attributions),
      ),
      freshness: mergeFreshness(...ok.map((r) => r.freshness)),
    };
  }

  async function getStopPlatforms(stopId: string): Promise<MobilityResult<TransitStop[]>> {
    const provider = await resolveByPrefix(stopId);
    if (!provider?.getStopPlatforms) return emptyResult<TransitStop[]>([]);
    const fn = provider.getStopPlatforms.bind(provider);
    const outcome = await timed(
      providerHealth,
      metricsRecorder,
      provider.id,
      "getStopPlatforms",
      () => fn(stopId),
    );
    return outcome.ok ? outcome.value : emptyResult<TransitStop[]>([]);
  }

  async function getStopInfrastructure(
    stopId: string,
  ): Promise<MobilityResult<TransitStopInfrastructure | null>> {
    const provider = await resolveByPrefix(stopId);
    if (!provider?.getStopInfrastructure)
      return emptyResult<TransitStopInfrastructure | null>(null);
    const fn = provider.getStopInfrastructure.bind(provider);
    const outcome = await timed(
      providerHealth,
      metricsRecorder,
      provider.id,
      "getStopInfrastructure",
      () => fn(stopId),
    );
    return outcome.ok ? outcome.value : emptyResult<TransitStopInfrastructure | null>(null);
  }

  async function getStopTimetable(
    stopId: string,
    date: string,
  ): Promise<MobilityResult<Departure[]>> {
    const provider = await resolveByPrefix(stopId);
    if (!provider?.getStopTimetable) return emptyResult<Departure[]>([]);
    const fn = provider.getStopTimetable.bind(provider);
    const outcome = await timed(
      providerHealth,
      metricsRecorder,
      provider.id,
      "getStopTimetable",
      () => fn(stopId, date),
    );
    // Provider may return TimetableEntry[]; we expose them as Departure[]
    // because every current implementer happens to emit Departure shapes.
    return outcome.ok
      ? (outcome.value as MobilityResult<Departure[]>)
      : emptyResult<Departure[]>([]);
  }

  async function getRoutesForStop(stopId: string): Promise<MobilityResult<TransitRoute[]>> {
    const provider = await resolveByPrefix(stopId);
    if (!provider) return emptyResult<TransitRoute[]>([]);

    // Prefer provider-native route lookup when available.
    if (provider.getRoutesForStop) {
      const fn = provider.getRoutesForStop.bind(provider);
      const outcome = await timed(
        providerHealth,
        metricsRecorder,
        provider.id,
        "getRoutesForStop",
        () => fn(stopId),
      );
      if (outcome.ok) {
        const result = outcome.value;
        // Keep old behavior: if provider route lookup returns nothing, derive
        // routes from departures as a fallback.
        if (result.data.length > 0 || !provider.getDepartures) return result;
      } else if (!provider.getDepartures) {
        return emptyResult<TransitRoute[]>([]);
      }
    } else if (!provider.getDepartures) {
      return emptyResult<TransitRoute[]>([]);
    }

    // Compatibility fallback: derive routes from a 12-hour departures window.
    // Several providers expose departures but no route-by-stop endpoint.
    const depFn = provider.getDepartures;
    if (!depFn) return emptyResult<TransitRoute[]>([]);
    const boundDep = depFn.bind(provider);
    const depOutcome = await timed(
      providerHealth,
      metricsRecorder,
      provider.id,
      "getRoutesForStop.viaDepartures",
      () => boundDep(stopId, 720),
    );
    if (!depOutcome.ok) return emptyResult<TransitRoute[]>([]);
    const depRes = depOutcome.value;
    const departures = depRes?.data;
    if (!departures) return emptyResult<TransitRoute[]>([]);
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
  }

  async function getRoutesInBbox(bbox: BBox): Promise<MobilityResult<TransitRoute[]>> {
    const matching = (await getProvidersForBbox(bbox)).filter((p) => p.getRoutesInBbox);
    const results = await Promise.allSettled(
      matching.map(async (p) => {
        if (!p.getRoutesInBbox) return null;
        const fn = p.getRoutesInBbox.bind(p);
        const outcome = await timed(providerHealth, metricsRecorder, p.id, "getRoutesInBbox", () =>
          fn(bbox),
        );
        return outcome.ok ? outcome.value : null;
      }),
    );
    const ok = results
      .map((r) => (r.status === "fulfilled" ? r.value : null))
      .filter((v): v is MobilityResult<TransitRoute[]> => v != null);
    return {
      data: ok.flatMap((r) => r.data),
      attributions: mergeAttributions(
        ctx.attributionIndex,
        ...resultsWithData(ok).map((r) => r.attributions),
      ),
      freshness: mergeFreshness(...ok.map((r) => r.freshness)),
    };
  }

  async function getRoute(routeId: string): Promise<MobilityResult<TransitRoute | null>> {
    const provider = await resolveByPrefix(routeId);
    if (!provider?.getRoute) return emptyResult<TransitRoute | null>(null);
    const fn = provider.getRoute.bind(provider);
    const outcome = await timed(providerHealth, metricsRecorder, provider.id, "getRoute", () =>
      fn(routeId),
    );
    return outcome.ok ? outcome.value : emptyResult<TransitRoute | null>(null);
  }

  async function getRouteStops(
    routeId: string,
    hintStopId?: string,
  ): Promise<MobilityResult<TransitStop[]>> {
    const provider = await resolveByPrefix(routeId);
    if (!provider) return emptyResult<TransitStop[]>([]);

    if (provider.getRouteStops) {
      const fn = provider.getRouteStops.bind(provider);
      const outcome = await timed(
        providerHealth,
        metricsRecorder,
        provider.id,
        "getRouteStops",
        () => fn(routeId, hintStopId),
      );
      if (outcome.ok) {
        const result = outcome.value;
        if (
          result.data.length > 0 ||
          !hintStopId ||
          !provider.getDepartures ||
          !provider.getVehicleJourney
        ) {
          return result;
        }
      } else if (!hintStopId || !provider.getDepartures || !provider.getVehicleJourney) {
        return emptyResult<TransitStop[]>([]);
      }
    } else if (!hintStopId || !provider.getDepartures || !provider.getVehicleJourney) {
      return emptyResult<TransitStop[]>([]);
    }

    // Compatibility fallback (pre-refactor behavior):
    // derive route stop sequence via a departure trip detail.
    const depFn = provider.getDepartures;
    const journeyFn = provider.getVehicleJourney;
    if (!depFn || !journeyFn || !hintStopId) return emptyResult<TransitStop[]>([]);

    const boundDep = depFn.bind(provider);
    const depOutcome = await timed(
      providerHealth,
      metricsRecorder,
      provider.id,
      "getRouteStops.viaDepartures",
      () => boundDep(hintStopId, 720),
    );
    if (!depOutcome.ok) return emptyResult<TransitStop[]>([]);
    const depRes = depOutcome.value;
    const departures = depRes?.data;
    if (!departures) return emptyResult<TransitStop[]>([]);
    const dep = departures.find((d) => d.route.id === routeId && !!d.tripId);
    if (!dep?.tripId) return emptyResult<TransitStop[]>([]);

    const boundJourney = journeyFn.bind(provider);
    const journeyOutcome = await timed(
      providerHealth,
      metricsRecorder,
      provider.id,
      "getRouteStops.viaJourney",
      () => boundJourney(dep.tripId as string),
    );
    if (!journeyOutcome.ok) return emptyResult<TransitStop[]>([]);
    const journeyRes = journeyOutcome.value;
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
      attributions: mergeAttributions(
        ctx.attributionIndex,
        depRes?.attributions ?? [],
        journeyRes?.attributions ?? [],
      ),
      freshness: mergeFreshness(
        depRes?.freshness ?? freshnessNow(),
        journeyRes?.freshness ?? freshnessNow(),
      ),
    };
  }

  async function getStopAlerts(stopId: string): Promise<MobilityResult<ServiceAlert[]>> {
    const provider = await resolveByPrefix(stopId);
    if (!provider?.getAlertsForStop)
      return emptyResult<ServiceAlert[]>([], { hasRealtimeData: true });
    const fn = provider.getAlertsForStop.bind(provider);
    const outcome = await timed(
      providerHealth,
      metricsRecorder,
      provider.id,
      "getAlertsForStop",
      () => fn(stopId),
    );
    return outcome.ok ? outcome.value : emptyResult<ServiceAlert[]>([], { hasRealtimeData: true });
  }

  async function getRouteAlerts(routeId: string): Promise<MobilityResult<ServiceAlert[]>> {
    const provider = await resolveByPrefix(routeId);
    if (!provider?.getAlertsForRoute)
      return emptyResult<ServiceAlert[]>([], { hasRealtimeData: true });
    const fn = provider.getAlertsForRoute.bind(provider);
    const outcome = await timed(
      providerHealth,
      metricsRecorder,
      provider.id,
      "getAlertsForRoute",
      () => fn(routeId),
    );
    return outcome.ok ? outcome.value : emptyResult<ServiceAlert[]>([], { hasRealtimeData: true });
  }

  async function getVehiclePositions(routeId: string): Promise<MobilityResult<VehiclePosition[]>> {
    const provider = await resolveByPrefix(routeId);
    if (!provider?.getVehiclePositions)
      return emptyResult<VehiclePosition[]>([], { hasRealtimeData: true });
    const fn = provider.getVehiclePositions.bind(provider);
    const outcome = await timed(
      providerHealth,
      metricsRecorder,
      provider.id,
      "getVehiclePositions",
      () => fn(routeId),
    );
    return outcome.ok
      ? outcome.value
      : emptyResult<VehiclePosition[]>([], { hasRealtimeData: true });
  }

  async function getLegGeometry(
    tripId: string,
    fromStopId?: string,
    toStopId?: string,
  ): Promise<MobilityResult<GeoJSONLineString | null>> {
    const provider = await resolveByPrefix(tripId);
    if (!provider?.getLegGeometry) return emptyResult<GeoJSONLineString | null>(null);
    const fn = provider.getLegGeometry.bind(provider);
    const outcome = await timed(
      providerHealth,
      metricsRecorder,
      provider.id,
      "getLegGeometry",
      () => fn(tripId, fromStopId, toStopId),
    );
    // GeoJSON LineString from the framework's LineString type matches our local
    // GeoJSONLineString shape closely enough (we widen coordinates to
    // [number, number][] at the boundary).
    return outcome.ok
      ? (outcome.value as unknown as MobilityResult<GeoJSONLineString | null>)
      : emptyResult<GeoJSONLineString | null>(null);
  }

  async function getVehicleJourney(
    vehicleId: string,
    fallbackIds?: string[],
  ): Promise<MobilityResult<VehicleJourney | null>> {
    const provider = await resolveByPrefix(vehicleId);
    if (!provider?.getVehicleJourney)
      return emptyResult<VehicleJourney | null>(null, { hasRealtimeData: true });
    const fn = provider.getVehicleJourney.bind(provider);
    const outcome = await timed(
      providerHealth,
      metricsRecorder,
      provider.id,
      "getVehicleJourney",
      () => fn(vehicleId, fallbackIds),
    );
    return outcome.ok
      ? outcome.value
      : emptyResult<VehicleJourney | null>(null, { hasRealtimeData: true });
  }

  async function getFacilities(stopId: string): Promise<MobilityResult<Facility[]>> {
    const provider = await resolveByPrefix(stopId);
    if (!provider?.getFacilities) return emptyResult<Facility[]>([]);
    const fn = provider.getFacilities.bind(provider);
    const outcome = await timed(providerHealth, metricsRecorder, provider.id, "getFacilities", () =>
      fn(stopId),
    );
    return outcome.ok ? outcome.value : emptyResult<Facility[]>([]);
  }

  async function getReachableStops(
    lat: number,
    lng: number,
    maxMinutes: number,
    modes?: string[],
  ): Promise<MobilityResult<TransitStop[]>> {
    // Use all healthy providers and merge results
    const candidates = collectProviders().filter((p) => p.getReachableStops);
    const allProviders = await filterHealthy(candidates);

    const results = await Promise.allSettled(
      allProviders.map(async (p) => {
        if (!p.getReachableStops) return null;
        const fn = p.getReachableStops.bind(p);
        const outcome = await timed(
          providerHealth,
          metricsRecorder,
          p.id,
          "getReachableStops",
          () => fn(lat, lng, maxMinutes, modes),
        );
        return outcome.ok ? outcome.value : null;
      }),
    );
    const ok = results
      .map((r) => (r.status === "fulfilled" ? r.value : null))
      .filter((v): v is MobilityResult<TransitStop[]> => v != null);
    return {
      data: ok.flatMap((r) => r.data),
      attributions: mergeAttributions(
        ctx.attributionIndex,
        ...resultsWithData(ok).map((r) => r.attributions),
      ),
      freshness: mergeFreshness(...ok.map((r) => r.freshness)),
    };
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
  };
}

export type TransitOrchestrator = ReturnType<typeof createTransitOrchestrator>;
