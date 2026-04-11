import {
  expandSearchQuery,
  getQueryVariants,
} from "../../../../../integrations/geocoding/query-expansion.js";
import { cacheGet, cacheSet, hashKey, TTL } from "../../utils/cache.js";
import {
  bucketTimestamps,
  diceSimilarity,
  haversineMeters,
  isTripNumber,
  normalizeHeadsign,
  normalizeShortName,
} from "./dedup";
import { transitOrchestrator } from "./orchestrator";
import type {
  BBox,
  Departure,
  Facility,
  MergedDeparture,
  MergedRoute,
  ServiceAlert,
  TransitStop,
} from "./types";

const LINK_RADIUS_M = 1000; // 1 km
const MIN_NAME_DICE = 0.4;
const MIN_INFORMATIVE_TOKEN_LEN = 4;

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

// Linked stops

/**
 * Find all transit stops that belong to a given OSM place.
 * Returns ALL stops within 1 km with name similarity >= 0.4 — NOT deduplicated —
 * so that multiple providers' entries for the same physical station are all kept
 * (their routes/departures will be merged separately).
 */
export async function getLinkedStops(
  lat: number,
  lng: number,
  name: string,
  placeId?: string,
): Promise<TransitStop[]> {
  const key = hashKey("transit:place-stops", { id: placeCacheId(lat, lng, name, placeId) });
  const cached = await cacheGet<TransitStop[]>(key);
  if (cached) return cached;

  // Scope dynamic providers to a ~1° buffer around the place (≈ 100 km) so that
  // providers from distant regions don't contribute stops that share stop-database
  // IDs but would then return their own regional routes via getRoutesForStop.
  const buf = 1.0;
  const placeBbox: BBox = [lng - buf, lat - buf, lng + buf, lat + buf];
  // Search with all synonym variants (e.g. "Hbf" + "Hauptbahnhof") so that
  // providers indexing either form are found, then deduplicate by stop id.
  const variants = getQueryVariants(name);
  const variantResults = await Promise.all(
    variants.map((v) => transitOrchestrator.searchByNameRaw(v, 30, placeBbox)),
  );
  const seen = new Set<string>();
  const raw = variantResults.flat().filter((s) => {
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
    await cacheSet(key, [], TTL.transit.placeStops);
    return [];
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

  await cacheSet(key, linked, TTL.transit.placeStops);
  return linked;
}

// Route merging

/**
 * Fetch routes for all linked stops and merge across providers.
 *
 * Deduplication key: (mode, shortName)
 * - Same route from DB + iRail → providers: ["db", "irail"], keep entry with color data
 * - Same route from 3 DB bus platforms → providers: ["db"] (one entry)
 */
export async function getMergedRoutes(
  lat: number,
  lng: number,
  name: string,
  placeId?: string,
): Promise<MergedRoute[]> {
  const cacheId = placeCacheId(lat, lng, name, placeId);
  const key = hashKey("transit:place-routes", { id: cacheId });
  const cached = await cacheGet<MergedRoute[]>(key);
  if (cached) return cached;

  const stops = await getLinkedStops(lat, lng, name, placeId);
  if (stops.length === 0) {
    await cacheSet(key, [], TTL.transit.placeRoutes);
    return [];
  }

  // Fetch routes for all stops in parallel
  const routeResults = await Promise.allSettled(
    stops.map((s) => transitOrchestrator.getRoutesForStop(s.id)),
  );

  // Map: "(mode):(shortName)" → best MergedRoute candidate
  const byKey = new Map<string, MergedRoute>();

  for (let i = 0; i < stops.length; i++) {
    const result = routeResults[i];
    if (result.status !== "fulfilled") continue;
    const providerName = stops[i].provider;

    for (const route of result.value) {
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
        // Already seen — merge providers
        if (!existing.providers.includes(providerName)) {
          existing.providers.push(providerName);
        }
        if (!existing.hintStopId) {
          existing.hintStopId = stops[i].id;
        }
        // Prefer entry with color data
        if (!existing.color && route.color) {
          existing.color = route.color;
          existing.textColor = route.textColor;
        }
      }
    }
  }

  const merged = Array.from(byKey.values());
  // Sort by mode then shortName for stable display order
  merged.sort((a, b) => {
    if (a.mode !== b.mode) return a.mode.localeCompare(b.mode);
    return a.shortName.localeCompare(b.shortName);
  });

  await cacheSet(key, merged, TTL.transit.placeRoutes);
  return merged;
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
  fetchFn: (stopId: string, minutes: number) => Promise<Departure[]>,
  minutes: number,
): Promise<MergedDeparture[]> {
  if (stops.length === 0) return [];

  const results = await Promise.allSettled(stops.map((s) => fetchFn(s.id, minutes)));
  const byKey = new Map<string, MergedDeparture>();

  function mergeInto(existing: MergedDeparture, dep: Departure, providerNames: string[]): void {
    for (const p of providerNames) {
      if (!existing.providers.includes(p)) existing.providers.push(p);
    }
    if (dep.tripId) {
      if (!existing.tripId) existing.tripId = dep.tripId;
      // Collect all non-empty tripIds for fallback lookups
      if (!existing.tripIds) existing.tripIds = existing.tripId ? [existing.tripId] : [];
      if (!existing.tripIds.includes(dep.tripId)) existing.tripIds.push(dep.tripId);
    }
    // Keep the earlier scheduledAt (providers may differ by 1–2 min for the same departure)
    if (dep.scheduledAt && dep.scheduledAt < existing.scheduledAt) {
      existing.scheduledAt = dep.scheduledAt;
    }
    if (!existing.expectedAt && dep.expectedAt) {
      existing.expectedAt = dep.expectedAt;
      existing.delaySeconds = dep.delaySeconds;
    }
    if (!existing.platform && dep.platform) existing.platform = dep.platform;
    if (dep.canceled) existing.canceled = true;
    if (dep.remarks?.length) {
      const existingTexts = new Set((existing.remarks ?? []).map((r) => r.text));
      for (const r of dep.remarks) {
        if (!existingTexts.has(r.text)) {
          existing.remarks = existing.remarks ?? [];
          existing.remarks.push(r);
          existingTexts.add(r.text);
        }
      }
    }
  }

  for (let i = 0; i < stops.length; i++) {
    const result = results[i];
    if (result.status !== "fulfilled") continue;
    const stopProvider = stops[i].provider;

    for (const dep of result.value) {
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

  const unique = new Set(byKey.values());
  return Array.from(unique).sort(
    (a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime(),
  );
}

export async function getMergedDepartures(
  lat: number,
  lng: number,
  name: string,
  minutes: number,
  placeId?: string,
): Promise<MergedDeparture[]> {
  const stops = await getLinkedStops(lat, lng, name, placeId);
  return buildMergedTimetable(
    stops,
    (id, min) => transitOrchestrator.getDepartures(id, min),
    minutes,
  );
}

export async function getMergedArrivals(
  lat: number,
  lng: number,
  name: string,
  minutes: number,
  placeId?: string,
): Promise<MergedDeparture[]> {
  const stops = await getLinkedStops(lat, lng, name, placeId);
  return buildMergedTimetable(
    stops,
    (id, min) => transitOrchestrator.getArrivals(id, min),
    minutes,
  );
}

// Alert merging

/**
 * Fetch alerts for all linked stops and deduplicate by alert id.
 * Cached 60 seconds.
 */
export async function getMergedAlerts(
  lat: number,
  lng: number,
  name: string,
  placeId?: string,
): Promise<ServiceAlert[]> {
  const cacheId = placeCacheId(lat, lng, name, placeId);
  const key = hashKey("transit:place-alerts", { id: cacheId });
  const cached = await cacheGet<ServiceAlert[]>(key);
  if (cached) return cached;

  const stops = await getLinkedStops(lat, lng, name, placeId);
  if (stops.length === 0) {
    await cacheSet(key, [], TTL.transit.placeAlerts);
    return [];
  }

  const alertResults = await Promise.allSettled(
    stops.map((s) => transitOrchestrator.getStopAlerts(s.id)),
  );
  const byId = new Map<string, ServiceAlert>();

  for (const result of alertResults) {
    if (result.status !== "fulfilled") continue;
    for (const alert of result.value) {
      const existing = byId.get(alert.id);
      if (!existing) {
        byId.set(alert.id, alert);
      } else {
        // Same alert from a second stop — merge providers
        for (const p of alert.providers) {
          if (!existing.providers.includes(p)) existing.providers.push(p);
        }
      }
    }
  }

  const merged = Array.from(byId.values());
  await cacheSet(key, merged, TTL.transit.placeAlerts);
  return merged;
}

// Facility merging

/**
 * Fetch facilities for all linked stops and deduplicate by facility id.
 * Cached 24 hours.
 */
export async function getMergedFacilities(
  lat: number,
  lng: number,
  name: string,
  placeId?: string,
): Promise<Facility[]> {
  const cacheId = placeCacheId(lat, lng, name, placeId);
  const key = hashKey("transit:place-facilities", { id: cacheId });
  const cached = await cacheGet<Facility[]>(key);
  if (cached) return cached;

  const stops = await getLinkedStops(lat, lng, name, placeId);
  if (stops.length === 0) {
    await cacheSet(key, [], TTL.transit.placeFacilities);
    return [];
  }

  const facResults = await Promise.allSettled(
    stops.map((s) => transitOrchestrator.getFacilities(s.id) as Promise<Facility[]>),
  );
  const byId = new Map<string, Facility>();

  for (const result of facResults) {
    if (result.status !== "fulfilled" || !Array.isArray(result.value)) continue;
    for (const fac of result.value) {
      if (!byId.has(fac.id)) byId.set(fac.id, fac);
    }
  }

  const merged = Array.from(byId.values());
  await cacheSet(key, merged, TTL.transit.placeFacilities);
  return merged;
}
