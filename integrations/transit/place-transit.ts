import type { BBox } from "@openmapx/core";
import { diceSimilarity, haversineMeters } from "@openmapx/core";
import type { IntegrationContext, TransitProvider } from "@openmapx/integration-framework";
import { captureTransitContributors } from "@openmapx/integration-framework";
import {
  expandSearchQuery,
  getQueryVariants,
} from "@openmapx/integration-geocoding/query-expansion";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  contributorsForField,
  contributorsForRecords,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import type { Freshness } from "@openmapx/mobility-core/freshness";
import { TTL as TTL_POLICY } from "@openmapx/mobility-core/policy";
import type { MobilityResult } from "@openmapx/mobility-core/result";
import type {
  Departure,
  Facility,
  MergedDeparture,
  MergedRoute,
  ServiceAlert,
  TransitStop,
} from "@openmapx/mobility-core/transit";
import { bucketTimestamps, isTripNumber, normalizeHeadsign, normalizeShortName } from "./dedup.js";
import type { TransitOrchestrator } from "./orchestrator.js";
import { emptyResult, mergeFreshness } from "./result-merge.js";

/** Preserve scalar ownership when a weaker row supplies a missing field. */
function retainFieldReceipt(
  record: {
    contributors?: readonly Attribution[];
    fieldContributors?: import("@openmapx/mobility-core/contributors").FieldContributors;
  },
  field: string,
  supplied: readonly Attribution[],
  append = false,
): void {
  const baseline =
    record.fieldContributors ??
    Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => key !== "contributors" && key !== "fieldContributors")
        .map(([key, value]) => [
          key,
          value === undefined || value === null || (Array.isArray(value) && value.length === 0)
            ? []
            : snapshotContributors(record.contributors ?? []),
        ]),
    );
  record.fieldContributors = {
    ...baseline,
    [field]: snapshotContributors(append ? (baseline[field] ?? []) : [], supplied),
  };
}

/** Extended Departure with optional feedTag (set by some providers like MOTIS). */
interface DepartureWithFeed extends Departure {
  feedTag?: string;
}

const LINK_RADIUS_M = 1000; // 1 km
// Place→stop linking deliberately uses a more permissive Dice floor (0.4)
// than `DEDUP.NAME_SIMILARITY_MIN` (0.6) because place names and transit
// stop names often differ stylistically ("Köln Hbf" vs "Köln
// Hauptbahnhof"). Tightening to the policy default would drop legitimate
// links.
const MIN_NAME_DICE = 0.4;
const MIN_INFORMATIVE_TOKEN_LEN = 4;

const TTL = {
  placeStops: TTL_POLICY.PLACE_LINK,
  placeRoutes: TTL_POLICY.SHORT_LIVED,
  placeAlerts: TTL_POLICY.REALTIME_WARM,
  placeFacilities: TTL_POLICY.STATIC_ARCHIVE,
  // Long enough that boards polling every 30 seconds don't repeat the whole
  // stop search, short enough that a recovered provider is picked up soon.
  partialDiscovery: TTL_POLICY.REALTIME_WARM,
};

/** A result built on a partial discovery is retried soon instead of living for its full lifetime. */
function cacheTtl(freshness: Freshness, completeTtl: number): number {
  return freshness.isPartial ? Math.min(completeTtl, TTL.partialDiscovery) : completeTtl;
}

/**
 * Resolve a route's raw provider ids (e.g. "ms", "db", "dyn:at/oebb") to
 * human-readable names from each provider's static attribution, mirroring the
 * prefix matching the orchestrator uses elsewhere. Provider ids and attribution
 * sourceIds are separate namespaces, so the UI can't derive these itself. Falls
 * back to the raw id when a provider declares no attribution.
 */
function resolveProviderNames(providers: TransitProvider[], ids: string[]): string[] {
  const names: string[] = [];
  for (const id of ids) {
    const match = providers.find(
      (p) => p.id === id || id === p.prefix.replace(/:$/, "") || id.startsWith(p.prefix),
    );
    const name = match?.attribution[0]?.name ?? id;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export interface PlaceTransit {
  getLinkedStops(
    lat: number,
    lng: number,
    name: string,
    placeId?: string,
  ): Promise<MobilityResult<TransitStop[]>>;
  getMergedRoutes(
    lat: number,
    lng: number,
    name: string,
    placeId?: string,
  ): Promise<MobilityResult<MergedRoute[]>>;
  getMergedDepartures(
    lat: number,
    lng: number,
    name: string,
    minutes: number,
    placeId?: string,
  ): Promise<MobilityResult<MergedDeparture[]>>;
  getMergedArrivals(
    lat: number,
    lng: number,
    name: string,
    minutes: number,
    placeId?: string,
  ): Promise<MobilityResult<MergedDeparture[]>>;
  getMergedAlerts(
    lat: number,
    lng: number,
    name: string,
    placeId?: string,
  ): Promise<MobilityResult<ServiceAlert[]>>;
  getMergedFacilities(
    lat: number,
    lng: number,
    name: string,
    placeId?: string,
  ): Promise<MobilityResult<Facility[]>>;
}

/** Build a deterministic cache key from prefix + data. */
function hashKey(prefix: string, data: unknown): string {
  // Simple but deterministic key — no crypto needed for cache keys
  const json = JSON.stringify(data);
  let hash = 0;
  for (let i = 0; i < json.length; i++) {
    const ch = json.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return `${prefix}:${(hash >>> 0).toString(36)}`;
}

function normalizeLinkName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeLinkName(name: string): string[] {
  const norm = normalizeLinkName(name);
  if (!norm) return [];
  return norm.split(" ").filter((t) => t.length > 0);
}

/** Canonical cache id from place coordinates + name (synonyms normalised). */
function placeCacheId(lat: number, lng: number, name: string, placeId?: string): string {
  if (placeId) return placeId;
  const canonicalName = expandSearchQuery(name).toLowerCase().replace(/\s+/g, "-");
  return `${lat.toFixed(5)}_${lng.toFixed(5)}_${canonicalName}`;
}

interface CachedStopsEnvelope {
  stops: TransitStop[];
  attributions: Attribution[];
  freshness: Freshness;
}

// Linked stops

export function createPlaceTransit(
  ctx: IntegrationContext,
  orchestrator: TransitOrchestrator,
): PlaceTransit {
  const cache = ctx.cache;

  /**
   * Find all transit stops that belong to a given OSM place.
   * Returns ALL stops within 1 km with name similarity >= 0.4 — NOT deduplicated —
   * so that multiple providers' entries for the same physical station are all kept
   * (their routes/departures will be merged separately).
   *
   * Only a complete discovery is cached for the full link lifetime. A partial one
   * (some stop search failed) is kept briefly under its own key, and a discovery
   * where no stop search answered rejects, so an outage never becomes a cached
   * "this place has no stops".
   */
  async function getLinkedStops(
    lat: number,
    lng: number,
    name: string,
    placeId?: string,
  ): Promise<MobilityResult<TransitStop[]>> {
    const id = placeCacheId(lat, lng, name, placeId);
    const key = hashKey("transit:place-stops", { id });
    const partialKey = hashKey("transit:place-stops-partial", { id });
    // All four station-panel requests share this discovery, including cold misses.
    const envelope = await cache.withCache<CachedStopsEnvelope>(
      key,
      TTL.placeStops,
      async () => {
        // The short-lived entry is best effort, like the shared cache's own reads and writes.
        const recent = await cache.get<CachedStopsEnvelope>(partialKey).catch(() => null);
        if (recent) return recent;
        const writer = (await cache.captureWriter?.()) ?? cache;
        const discovered = await discoverLinkedStops(lat, lng, name);
        if (discovered.freshness.isPartial) {
          await writer.set(partialKey, discovered, TTL.partialDiscovery).catch(() => {});
        }
        return discovered;
      },
      undefined,
      (value) => !value.freshness.isPartial,
    );
    return {
      data: envelope.stops,
      attributions: envelope.attributions,
      freshness: envelope.freshness,
    };
  }

  async function discoverLinkedStops(
    lat: number,
    lng: number,
    name: string,
  ): Promise<CachedStopsEnvelope> {
    // Scope dynamic providers to a ~1 degree buffer around the place (approx 100 km) so that
    // providers from distant regions don't contribute stops that share stop-database
    // IDs but would then return their own regional routes via getRoutesForStop.
    const buf = 1.0;
    const placeBbox: BBox = [lng - buf, lat - buf, lng + buf, lat + buf];
    // Search with all synonym variants (e.g. "Hbf" + "Hauptbahnhof") so that
    // providers indexing either form are found, then deduplicate by stop id.
    const variants = getQueryVariants(name);
    const settled = await Promise.allSettled(
      variants.map((v) => orchestrator.searchByNameRaw(v, 30, placeBbox)),
    );
    const variantResults = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed && variantResults.length === 0) throw failed.reason;
    const merged = mergeFreshness(...variantResults.map((r) => r.freshness));
    const freshness: Freshness = failed ? { ...merged, isPartial: true } : merged;
    const seen = new Set<string>();
    const raw = variantResults
      .flatMap((r) => captureTransitContributors(r.data, r.attributions))
      .filter((s) => {
        if (seen.has(s.id)) return false;
        seen.add(s.id);
        return true;
      });
    const normVariants = variants
      .map((v) => normalizeLinkName(v))
      .filter((v, i, arr) => v.length > 0 && arr.indexOf(v) === i);

    // First-pass candidates: distance + fuzzy name match against any query variant.
    const prelim = raw.filter((stop) => {
      if (haversineMeters(lat, lng, stop.lat, stop.lng) > LINK_RADIUS_M) return false;
      const stopNorm = normalizeLinkName(stop.name);
      if (!stopNorm) return false;
      let best = 0;
      for (const q of normVariants) {
        const score = diceSimilarity(stopNorm, q);
        if (score > best) best = score;
      }
      return best >= MIN_NAME_DICE;
    });

    if (prelim.length === 0) {
      return { stops: [], attributions: [], freshness };
    }

    // Second-pass pruning: avoid linking by city token only.
    // Keep candidates that share at least one informative token from the place
    // name variants (tokens present in some, but not all, prelim candidates).
    const tokenFreq = new Map<string, number>();
    const prelimTokenSets = prelim.map((s) => new Set(tokenizeLinkName(s.name)));
    for (const tokens of prelimTokenSets) {
      for (const t of tokens) {
        tokenFreq.set(t, (tokenFreq.get(t) ?? 0) + 1);
      }
    }

    const placeTokens = new Set<string>();
    for (const q of normVariants) {
      for (const t of tokenizeLinkName(q)) {
        if (t.length < MIN_INFORMATIVE_TOKEN_LEN) continue;
        if (/^\d+$/.test(t)) continue;
        placeTokens.add(t);
      }
    }

    const informativeTokens = Array.from(placeTokens).filter((t) => {
      const count = tokenFreq.get(t) ?? 0;
      return count > 0 && count < prelim.length;
    });

    const linked =
      informativeTokens.length === 0
        ? prelim
        : prelim.filter((_, i) => informativeTokens.some((t) => prelimTokenSets[i].has(t)));

    return { stops: linked, attributions: contributorsForRecords(linked), freshness };
  }

  // Route merging

  /**
   * Fetch routes for all linked stops and merge across providers.
   *
   * Deduplication key: (mode, shortName)
   * - Same route from DB + iRail -> providers: ["db", "irail"], keep entry with color data
   * - Same route from 3 DB bus platforms -> providers: ["db"] (one entry)
   */
  async function getMergedRoutes(
    lat: number,
    lng: number,
    name: string,
    placeId?: string,
  ): Promise<MobilityResult<MergedRoute[]>> {
    const cacheId = placeCacheId(lat, lng, name, placeId);
    const key = hashKey("transit:place-routes", { id: cacheId });
    interface CachedRoutes {
      routes: MergedRoute[];
      attributions: Attribution[];
      freshness: Freshness;
    }
    const cached = await cache.get<CachedRoutes>(key);
    if (cached) {
      return {
        data: cached.routes,
        attributions: cached.attributions,
        freshness: cached.freshness,
      };
    }

    const stopsRes = await getLinkedStops(lat, lng, name, placeId);
    const stops = stopsRes.data;
    if (stops.length === 0) {
      const envelope: CachedRoutes = {
        routes: [],
        attributions: [],
        freshness: stopsRes.freshness,
      };
      await cache.set(key, envelope, cacheTtl(envelope.freshness, TTL.placeRoutes));
      return { data: [], attributions: [], freshness: stopsRes.freshness };
    }

    // Fetch routes for all stops in parallel
    const routeResults = await Promise.allSettled(
      stops.map((s) => orchestrator.getRoutesForStop(s.id)),
    );

    // Map: "(mode):(shortName)" -> best MergedRoute candidate
    const byKey = new Map<string, MergedRoute>();
    // Attribute only providers that actually returned routes — NOT the stop-search
    // fan-out, which queries every provider (and the dynamic registry's whole
    // operator catalog) regardless of whether they contribute displayed lines.
    const allFresh: Freshness[] = [stopsRes.freshness];

    for (let i = 0; i < stops.length; i++) {
      const result = routeResults[i];
      if (result.status !== "fulfilled") continue;
      const providerName = stops[i].provider;
      allFresh.push(result.value.freshness);

      for (const route of captureTransitContributors(
        result.value.data,
        result.value.attributions,
      )) {
        if (isTripNumber(route.shortName)) continue;
        const k = `${route.mode}:${normalizeShortName(route.shortName)}`;
        const existing = byKey.get(k);

        if (!existing) {
          // First time seeing this route
          byKey.set(k, {
            ...route,
            providers: [providerName],
            hintStopId: stops[i].id,
          } as MergedRoute);
        } else {
          let contributed = false;
          // Already seen — merge providers
          if (!existing.providers.includes(providerName)) {
            retainFieldReceipt(existing, "providers", route.contributors ?? [], true);
            existing.providers.push(providerName);
            contributed = true;
          }
          if (!existing.hintStopId) {
            retainFieldReceipt(existing, "hintStopId", route.contributors ?? []);
            existing.hintStopId = stops[i].id;
            contributed = true;
          }
          // Prefer entry with color data
          if (!existing.color && route.color) {
            retainFieldReceipt(existing, "color", contributorsForField(route, "color"));
            retainFieldReceipt(existing, "textColor", contributorsForField(route, "textColor"));
            existing.color = route.color;
            contributed = true;
            existing.textColor = route.textColor;
          }
          if (contributed)
            existing.contributors = snapshotContributors(
              existing.contributors ?? [],
              route.contributors ?? [],
            );
        }
      }
    }

    const merged = Array.from(byKey.values());
    // Sort by mode then shortName for stable display order
    merged.sort((a, b) => {
      if (a.mode !== b.mode) return a.mode.localeCompare(b.mode);
      return a.shortName.localeCompare(b.shortName);
    });

    // Resolve provider ids to human-readable names for the line-badge tooltip.
    const providerDefs = orchestrator.collectProviders();
    for (const route of merged) {
      route.providerNames = resolveProviderNames(providerDefs, route.providers);
    }

    const attributions = contributorsForRecords(merged);
    const freshness = mergeFreshness(...allFresh);
    const envelope: CachedRoutes = { routes: merged, attributions, freshness };
    await cache.set(key, envelope, cacheTtl(envelope.freshness, TTL.placeRoutes));
    return { data: merged, attributions, freshness };
  }

  // Timetable merging (shared by departures & arrivals)

  /**
   * Merge departures/arrivals from all linked stops using multi-key dedup.
   *
   * Deduplication keys per entry:
   *   k1 (primary):   normalizedShortName + scheduledAt
   *   k2 (secondary): normalizedHeadsign + scheduledAt + platform
   *   k3 (fallback):  normalizedHeadsign + scheduledAt (no platform)
   *
   * Not cached — caller refetches every 30s for real-time data.
   */
  async function buildMergedTimetable(
    stops: TransitStop[],
    fetchFn: (stopId: string, minutes: number) => Promise<MobilityResult<Departure[]>>,
    minutes: number,
  ): Promise<MobilityResult<MergedDeparture[]>> {
    if (stops.length === 0) return emptyResult<MergedDeparture[]>([], { hasRealtimeData: true });

    const results = await Promise.allSettled(stops.map((s) => fetchFn(s.id, minutes)));
    if (results.every((result) => result.status === "rejected")) {
      // A transport failure must not replace a cached timetable with a successful empty result.
      throw new Error("Transit timetable sources unavailable");
    }
    const partial = results.some((result) => result.status === "rejected");
    const byKey = new Map<string, MergedDeparture>();
    const allFresh: Freshness[] = [];

    function mergeInto(
      existing: MergedDeparture,
      dep: DepartureWithFeed,
      providerNames: string[],
    ): void {
      let contributed = false;
      for (const p of providerNames) {
        if (!existing.providers.includes(p)) {
          retainFieldReceipt(existing, "providers", dep.contributors ?? [], true);
          existing.providers.push(p);
          contributed = true;
        }
      }
      if (dep.tripId) {
        if (!existing.tripId) {
          retainFieldReceipt(existing, "tripId", contributorsForField(dep, "tripId"));
          existing.tripId = dep.tripId;
          contributed = true;
        }
        // Collect all non-empty tripIds for fallback lookups
        if (!existing.tripIds) existing.tripIds = existing.tripId ? [existing.tripId] : [];
        if (!existing.tripIds.includes(dep.tripId)) {
          retainFieldReceipt(existing, "tripIds", contributorsForField(dep, "tripId"), true);
          existing.tripIds.push(dep.tripId);
          contributed = true;
        }
      }
      // Keep the earlier scheduledAt (providers may differ by 1-2 min for the same departure)
      if (dep.scheduledAt && dep.scheduledAt < existing.scheduledAt) {
        retainFieldReceipt(existing, "scheduledAt", contributorsForField(dep, "scheduledAt"));
        existing.scheduledAt = dep.scheduledAt;
        contributed = true;
      }
      if (!existing.expectedAt && dep.expectedAt) {
        retainFieldReceipt(existing, "expectedAt", contributorsForField(dep, "expectedAt"));
        retainFieldReceipt(existing, "delaySeconds", contributorsForField(dep, "delaySeconds"));
        existing.expectedAt = dep.expectedAt;
        contributed = true;
        existing.delaySeconds = dep.delaySeconds;
      }
      if (!existing.platform && dep.platform) {
        retainFieldReceipt(existing, "platform", contributorsForField(dep, "platform"));
        existing.platform = dep.platform;
        contributed = true;
      }
      if (dep.canceled && !existing.canceled) {
        retainFieldReceipt(existing, "canceled", contributorsForField(dep, "canceled"));
        existing.canceled = true;
        contributed = true;
      }
      if (dep.remarks?.length) {
        const existingTexts = new Set((existing.remarks ?? []).map((r) => r.text));
        for (const r of dep.remarks) {
          if (!existingTexts.has(r.text)) {
            existing.remarks = existing.remarks ?? [];
            retainFieldReceipt(
              existing,
              "remarks",
              r.contributors ?? contributorsForField(dep, "remarks"),
              true,
            );
            existing.remarks.push(r);
            contributed = true;
            existingTexts.add(r.text);
          }
        }
      }
      if (contributed)
        existing.contributors = snapshotContributors(
          existing.contributors ?? [],
          dep.contributors ?? [],
        );
    }

    for (let i = 0; i < stops.length; i++) {
      const result = results[i];
      if (result.status !== "fulfilled") continue;
      const stopProvider = stops[i].provider;
      allFresh.push(result.value.freshness);

      for (const dep of captureTransitContributors(
        result.value.data,
        result.value.attributions,
      ) as DepartureWithFeed[]) {
        // Include both feed-level tag (e.g. "de_DELFI") and instance provider (e.g. "mo")
        const feedProviders: string[] = [];
        if (dep.feedTag) feedProviders.push(dep.feedTag);
        if (stopProvider && stopProvider !== dep.feedTag) feedProviders.push(stopProvider);
        const providerName = feedProviders[0] ?? stopProvider;
        // Two adjacent 2-min buckets eliminate boundary issues (e.g. 22:41 vs 22:42)
        const [bucket0, bucket1] = bucketTimestamps(dep.scheduledAt);
        const normShort = normalizeShortName(dep.route.shortName);
        const normHeadsign = dep.headsign ? normalizeHeadsign(dep.headsign) : null;

        // Build all candidate keys (primary bucket + neighbor bucket)
        const k1a = `${normShort}:${bucket0}`;
        const k1b = `${normShort}:${bucket1}`;
        const k2a =
          normHeadsign && dep.platform ? `trip:${normHeadsign}:${bucket0}:${dep.platform}` : null;
        const k2b =
          normHeadsign && dep.platform ? `trip:${normHeadsign}:${bucket1}:${dep.platform}` : null;
        const k3a = normHeadsign ? `trip:${normHeadsign}:${bucket0}` : null;
        const k3b = normHeadsign ? `trip:${normHeadsign}:${bucket1}` : null;

        // Look up in both buckets
        const existing =
          byKey.get(k1a) ??
          byKey.get(k1b) ??
          (k2a ? byKey.get(k2a) : undefined) ??
          (k2b ? byKey.get(k2b) : undefined) ??
          (k3a ? byKey.get(k3a) : undefined) ??
          (k3b ? byKey.get(k3b) : undefined);

        if (!existing) {
          const entry: MergedDeparture = {
            ...dep,
            providers: feedProviders.length ? [...feedProviders] : [providerName],
            tripIds: dep.tripId ? [dep.tripId] : [],
          };
          // Register under primary bucket keys only (neighbor is for lookup, not storage)
          byKey.set(k1a, entry);
          if (k2a) byKey.set(k2a, entry);
          if (k3a) byKey.set(k3a, entry);
        } else {
          // Register alias keys so future lookups from either bucket find this entry
          if (!byKey.has(k1a)) byKey.set(k1a, existing);
          if (!byKey.has(k1b)) byKey.set(k1b, existing);
          if (k2a && !byKey.has(k2a)) byKey.set(k2a, existing);
          if (k2b && !byKey.has(k2b)) byKey.set(k2b, existing);
          if (k3a && !byKey.has(k3a)) byKey.set(k3a, existing);
          if (k3b && !byKey.has(k3b)) byKey.set(k3b, existing);
          mergeInto(existing, dep, feedProviders.length ? feedProviders : [providerName]);
        }
      }
    }

    const unique = Array.from(new Set(byKey.values())).sort(
      (a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime(),
    );
    return {
      data: unique,
      attributions: contributorsForRecords(unique),
      freshness: { ...mergeFreshness(...allFresh), ...(partial ? { isPartial: true } : {}) },
    };
  }

  async function getMergedDepartures(
    lat: number,
    lng: number,
    name: string,
    minutes: number,
    placeId?: string,
  ): Promise<MobilityResult<MergedDeparture[]>> {
    const stopsRes = await getLinkedStops(lat, lng, name, placeId);
    const merged = await buildMergedTimetable(
      stopsRes.data,
      (id, min) => orchestrator.getDepartures(id, min),
      minutes,
    );
    return {
      data: merged.data,
      // Attribute only the timetable results, not the stop-search fan-out.
      attributions: merged.attributions,
      freshness: mergeFreshness(stopsRes.freshness, merged.freshness),
    };
  }

  async function getMergedArrivals(
    lat: number,
    lng: number,
    name: string,
    minutes: number,
    placeId?: string,
  ): Promise<MobilityResult<MergedDeparture[]>> {
    const stopsRes = await getLinkedStops(lat, lng, name, placeId);
    const merged = await buildMergedTimetable(
      stopsRes.data,
      (id, min) => orchestrator.getArrivals(id, min),
      minutes,
    );
    return {
      data: merged.data,
      // Attribute only the timetable results, not the stop-search fan-out.
      attributions: merged.attributions,
      freshness: mergeFreshness(stopsRes.freshness, merged.freshness),
    };
  }

  // Alert merging

  /**
   * Fetch alerts for all linked stops and deduplicate by alert id.
   * Cached 60 seconds.
   */
  async function getMergedAlerts(
    lat: number,
    lng: number,
    name: string,
    placeId?: string,
  ): Promise<MobilityResult<ServiceAlert[]>> {
    interface CachedAlerts {
      alerts: ServiceAlert[];
      attributions: Attribution[];
      freshness: Freshness;
    }
    const cacheId = placeCacheId(lat, lng, name, placeId);
    const key = hashKey("transit:place-alerts", { id: cacheId });
    const cached = await cache.get<CachedAlerts>(key);
    if (cached) {
      return {
        data: cached.alerts,
        attributions: cached.attributions,
        freshness: cached.freshness,
      };
    }

    const stopsRes = await getLinkedStops(lat, lng, name, placeId);
    const stops = stopsRes.data;
    if (stops.length === 0) {
      const envelope: CachedAlerts = {
        alerts: [],
        attributions: [],
        freshness: stopsRes.freshness,
      };
      await cache.set(key, envelope, cacheTtl(envelope.freshness, TTL.placeAlerts));
      return { data: [], attributions: [], freshness: stopsRes.freshness };
    }

    const alertResults = await Promise.allSettled(
      stops.map((s) => orchestrator.getStopAlerts(s.id)),
    );
    const byId = new Map<string, ServiceAlert>();
    // Attribute only providers that returned alerts, not the stop-search fan-out.
    const allFresh: Freshness[] = [stopsRes.freshness];

    for (const result of alertResults) {
      if (result.status !== "fulfilled") continue;
      allFresh.push(result.value.freshness);
      for (const alert of captureTransitContributors(
        result.value.data,
        result.value.attributions,
      )) {
        const existing = byId.get(alert.id);
        if (!existing) {
          byId.set(alert.id, alert);
        } else {
          // A retained provider identity is a contribution; identical duplicates are not.
          let added = false;
          for (const p of alert.providers) {
            if (!existing.providers.includes(p)) {
              existing.providers.push(p);
              added = true;
            }
          }
          if (added)
            existing.contributors = snapshotContributors(
              existing.contributors ?? [],
              alert.contributors ?? [],
            );
        }
      }
    }

    const merged = Array.from(byId.values());
    const attributions = contributorsForRecords(merged);
    const freshness = mergeFreshness(...allFresh);
    const envelope: CachedAlerts = { alerts: merged, attributions, freshness };
    await cache.set(key, envelope, cacheTtl(envelope.freshness, TTL.placeAlerts));
    return { data: merged, attributions, freshness };
  }

  // Facility merging

  /**
   * Fetch facilities for all linked stops and deduplicate by facility id.
   * Cached 24 hours.
   */
  async function getMergedFacilities(
    lat: number,
    lng: number,
    name: string,
    placeId?: string,
  ): Promise<MobilityResult<Facility[]>> {
    interface CachedFacilities {
      facilities: Facility[];
      attributions: Attribution[];
      freshness: Freshness;
    }
    const cacheId = placeCacheId(lat, lng, name, placeId);
    const key = hashKey("transit:place-facilities", { id: cacheId });
    const cached = await cache.get<CachedFacilities>(key);
    if (cached) {
      return {
        data: cached.facilities,
        attributions: cached.attributions,
        freshness: cached.freshness,
      };
    }

    const stopsRes = await getLinkedStops(lat, lng, name, placeId);
    const stops = stopsRes.data;
    if (stops.length === 0) {
      const envelope: CachedFacilities = {
        facilities: [],
        attributions: [],
        freshness: stopsRes.freshness,
      };
      await cache.set(key, envelope, cacheTtl(envelope.freshness, TTL.placeFacilities));
      return { data: [], attributions: [], freshness: stopsRes.freshness };
    }

    const facResults = await Promise.allSettled(stops.map((s) => orchestrator.getFacilities(s.id)));
    const byId = new Map<string, Facility>();
    // Attribute only providers that returned facilities, not the stop-search fan-out.
    const allFresh: Freshness[] = [stopsRes.freshness];

    for (const result of facResults) {
      if (result.status !== "fulfilled") continue;
      allFresh.push(result.value.freshness);
      for (const fac of captureTransitContributors(result.value.data, result.value.attributions)) {
        if (!byId.has(fac.id)) byId.set(fac.id, fac);
      }
    }

    const merged = Array.from(byId.values());
    const attributions = contributorsForRecords(merged);
    const freshness = mergeFreshness(...allFresh);
    const envelope: CachedFacilities = { facilities: merged, attributions, freshness };
    await cache.set(key, envelope, cacheTtl(envelope.freshness, TTL.placeFacilities));
    return { data: merged, attributions, freshness };
  }

  return {
    getLinkedStops,
    getMergedRoutes,
    getMergedDepartures,
    getMergedArrivals,
    getMergedAlerts,
    getMergedFacilities,
  };
}
