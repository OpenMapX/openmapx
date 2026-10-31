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
import { platformChanged } from "@openmapx/mobility-core/platform";
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
import {
  bucketTimestamps,
  headsignsCompatible,
  isTripNumber,
  lineNamesCompatible,
  normalizeHeadsign,
  normalizeShortName,
} from "./dedup.js";
import type { TransitOrchestrator } from "./orchestrator.js";
import { emptyResult, mergeFreshness } from "./result-merge.js";
import {
  mainStopKey,
  stopNameKey,
  stopNameSpecificity,
  withoutBracketedParts,
} from "./stop-names.js";

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

/** A stop a merged row was listed at, with the receipt for its name. */
interface RowStop {
  id: string;
  name: string;
  receipt: readonly Attribution[];
  /** The source named this as the departure's own stop, not just the stop it asked about. */
  stated: boolean;
}

/**
 * The stop a departure leaves from: its own stop when the source states one,
 * else the linked stop whose board listed it.
 */
function departureStop(dep: Departure, linked: TransitStop): RowStop {
  if (dep.stop?.id && dep.stop.name) {
    return {
      id: dep.stop.id,
      name: dep.stop.name,
      receipt: contributorsForField(dep, "stop"),
      stated: true,
    };
  }
  return {
    id: linked.id,
    name: linked.name,
    receipt: contributorsForField(linked, "name"),
    stated: false,
  };
}

/**
 * Name the stop each merged row leaves from, and mark rows whose stop is not
 * the place's main one when the board's stops have different names.
 *
 * Spellings of one name ("Köln Hbf", "Köln Hauptbahnhof") count as one stop.
 * The main stop is the one the place was opened for, such as a journey's stop,
 * else the one named like the place (see {@link mainStopKey}). A
 * row listed at the main stop by any source stays there, because a stop's
 * board can include a whole station's departures. Otherwise a stop the source
 * names as the departure's own wins over the stop it was asked about, then
 * the most specifically named one.
 */
function nameRowStops(
  rows: { row: MergedDeparture; stops: RowStop[] }[],
  placeName: string,
  openedFor?: string,
): void {
  const keyed = rows.map(({ row, stops }) => ({
    row,
    stops: stops.map((stop) => ({ stop, key: stopNameKey(stop.name) })),
  }));
  const rowsByKey = new Map<string, number>();
  for (const { stops } of keyed) {
    for (const key of new Set(stops.map((s) => s.key))) {
      rowsByKey.set(key, (rowsByKey.get(key) ?? 0) + 1);
    }
  }
  const main = rowsByKey.size > 1 ? mainStopKey(placeName, rowsByKey, openedFor) : undefined;
  for (const { row, stops } of keyed) {
    let chosen: { stop: RowStop; key: string } | undefined;
    for (const candidate of stops) {
      if (!chosen || rank(candidate) > rank(chosen)) chosen = candidate;
    }
    if (!chosen) continue;
    retainFieldReceipt(row, "stop", chosen.stop.receipt);
    row.stop = { id: chosen.stop.id, name: chosen.stop.name };
    row.contributors = snapshotContributors(row.contributors ?? [], chosen.stop.receipt);
    if (main !== undefined && chosen.key !== main) {
      retainFieldReceipt(row, "atOtherStop", chosen.stop.receipt);
      row.atOtherStop = true;
    }
  }

  function rank({ stop, key }: { stop: RowStop; key: string }): number {
    return (key === main ? 10_000 : 0) + (stop.stated ? 1_000 : 0) + stopNameSpecificity(key);
  }
}

/** A source's departure folded into a merged row. */
interface FoldedDeparture {
  stop: RowStop;
  /** The linked stop's provider. */
  provider: string;
  tripId: string;
  scheduledAt: string;
  line: string;
  headsign: string;
  /** The planned platform, else the current one. */
  platform?: string;
  /** The departure as its source listed it. */
  departure: Departure;
}

/**
 * Whether a source's departure repeats one it already listed: the same
 * scheduled time, line and direction, and the same platform where both state
 * one. Two trains of a line can't leave in the same direction at the same
 * minute, so this holds whatever trip ids the source gave each copy.
 */
function repeats(part: FoldedDeparture, dep: Departure): boolean {
  const platform = dep.scheduledPlatform ?? dep.platform;
  return (
    part.scheduledAt === dep.scheduledAt &&
    normalizeShortName(part.line) === normalizeShortName(dep.route.shortName) &&
    headsignsCompatible(part.headsign, dep.headsign) &&
    (!part.platform || !platform || part.platform === platform)
  );
}

/**
 * The value `stated` by the most sources, counting each source once. A tie goes to
 * the value more sources state by `tieBreak`, then to the first source's.
 */
function mostStated(
  parts: readonly FoldedDeparture[],
  stated: (departure: Departure) => string | undefined,
  tieBreak?: (value: string) => number,
): { value: string; departure: Departure } | undefined {
  const sources = new Map<string, Set<string>>();
  for (const { departure, provider } of parts) {
    const value = stated(departure);
    if (!value) continue;
    const stating = sources.get(value) ?? new Set<string>();
    stating.add(provider);
    sources.set(value, stating);
  }
  let best: { value: string; departure: Departure; score: [number, number] } | undefined;
  for (const { departure } of parts) {
    const value = stated(departure);
    if (!value) continue;
    const score: [number, number] = [sources.get(value)?.size ?? 0, tieBreak?.(value) ?? 0];
    if (
      !best ||
      score[0] > best.score[0] ||
      (score[0] === best.score[0] && score[1] > best.score[1])
    )
      best = { value, departure, score };
  }
  return best && { value: best.value, departure: best.departure };
}

/**
 * Set the platform a merged row shows. Sources number platforms differently:
 * at Köln Messe/Deutz, Transitous passes on DELFI's internal numbers ("85")
 * while the HAFAS sources give the track riders see ("2"), and for some trains
 * Transitous pairs DELFI's planned number with the real current track.
 *
 * The planned platform is the one the most sources plan. A source's platform
 * change counts when it moves the departure off both its own plan and that
 * one, because a source that only knows the plan can't report it. Otherwise
 * the current platform is the one the most sources give. A tie keeps the
 * first source's.
 */
function choosePlatform(row: MergedDeparture, parts: readonly FoldedDeparture[]): void {
  const stated = parts.filter((part) => part.departure.platform);
  if (stated.length === 0) return;
  const statingCurrent = (value: string) =>
    new Set(stated.filter((part) => part.departure.platform === value).map((p) => p.provider)).size;
  const plan = mostStated(stated, (d) => d.scheduledPlatform ?? d.platform, statingCurrent);
  const changed = stated.filter(
    ({ departure: d }) =>
      platformChanged(d.scheduledPlatform, d.platform) && platformChanged(plan?.value, d.platform),
  );
  const current = mostStated(changed.length > 0 ? changed : stated, (d) => d.platform);
  if (!current) return;
  // Without a change, keep a scheduled platform only where a source states it.
  const scheduled =
    changed.length > 0
      ? plan
      : stated
          .map(({ departure }) => departure)
          .filter((d) => d.scheduledPlatform === current.value)
          .map((departure) => ({ value: current.value, departure }))[0];
  if (row.platform !== current.value) {
    retainFieldReceipt(row, "platform", contributorsForField(current.departure, "platform"));
    row.platform = current.value;
    row.contributors = snapshotContributors(
      row.contributors ?? [],
      current.departure.contributors ?? [],
    );
  }
  if (row.scheduledPlatform === scheduled?.value) return;
  if (scheduled) {
    retainFieldReceipt(
      row,
      "scheduledPlatform",
      contributorsForField(scheduled.departure, "scheduledPlatform"),
    );
    row.scheduledPlatform = scheduled.value;
    row.contributors = snapshotContributors(
      row.contributors ?? [],
      scheduled.departure.contributors ?? [],
    );
  } else {
    retainFieldReceipt(row, "scheduledPlatform", []);
    delete row.scheduledPlatform;
  }
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

/**
 * Whether some of a place's per-stop lookups failed. When all of them failed it
 * rejects instead, so an outage is neither shown nor cached as "nothing here".
 */
function partialLookups(results: PromiseSettledResult<unknown>[], what: string): boolean {
  const failed = results.filter((result) => result.status === "rejected").length;
  if (failed > 0 && failed === results.length) {
    throw new Error(`Transit ${what} sources unavailable`);
  }
  return failed > 0;
}

function withPartial(freshness: Freshness, partial: boolean): Freshness {
  return partial ? { ...freshness, isPartial: true } : freshness;
}

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

/** A place whose transit stops a board links, as the client knows it. */
export interface PlaceQuery {
  lat: number;
  lng: number;
  /** The name shown to the user, which may be a translation. */
  name: string;
  /** The client's id for the place. */
  placeId?: string;
  /** The place's OSM object ("node/123"); its local name links the stops. */
  osmRef?: string;
  /**
   * The transit stop the place was opened for, such as a journey's stop: its
   * name also links stops, and its departures count as the main stop's.
   */
  stopName?: string;
}

export interface PlaceTransit {
  getLinkedStops(place: PlaceQuery): Promise<MobilityResult<TransitStop[]>>;
  getMergedRoutes(place: PlaceQuery): Promise<MobilityResult<MergedRoute[]>>;
  getMergedDepartures(
    place: PlaceQuery,
    minutes: number,
  ): Promise<MobilityResult<MergedDeparture[]>>;
  getMergedArrivals(place: PlaceQuery, minutes: number): Promise<MobilityResult<MergedDeparture[]>>;
  getMergedAlerts(place: PlaceQuery): Promise<MobilityResult<ServiceAlert[]>>;
  getMergedFacilities(place: PlaceQuery): Promise<MobilityResult<Facility[]>>;
}

export interface PlaceTransitOptions {
  /**
   * The local name of an OSM object ("node/123"): OSM's `name` tag, which is
   * how transit sources name a station. Translated names such as "Munich
   * Central Station" don't find "München Hbf".
   */
  lookupLocalName?: (osmRef: string) => Promise<string | undefined>;
}

/** The names that link a place's stops, and the identity of its cached links. */
interface PlaceLink {
  lat: number;
  lng: number;
  /** Search names: the local name (else the shown one) and the opened stop's. */
  names: string[];
  /** The name the place's main stop is named like. */
  placeName: string;
  openedFor?: string;
  cacheId: string;
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
  return withoutBracketedParts(name, ["()"])
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeLinkName(name: string): string[] {
  const norm = normalizeLinkName(name);
  if (!norm) return [];
  return norm.split(" ").filter((t) => t.length > 0);
}

/** A name's canonical form, so "Köln Hbf" and "Köln Hauptbahnhof" are one. */
function canonicalLinkName(name: string): string {
  return expandSearchQuery(name).toLowerCase().replace(/\s+/g, "-");
}

/**
 * Cache identity of a place's links: the place, and the names that linked its
 * stops, so a board found by one name never stands in for another name's.
 */
function placeCacheId(lat: number, lng: number, names: string[], placeId?: string): string {
  const place = placeId ?? `${lat.toFixed(5)}_${lng.toFixed(5)}`;
  return [place, ...names.map(canonicalLinkName)].join("|");
}

const OSM_REF = /^(node|way|relation)\/[1-9]\d*$/;

/**
 * The stops a place's name links: within 1 km and named similarly to the name
 * or one of its spellings, and, when the candidates differ in other words,
 * sharing one of those words with the name, so a stop isn't linked by its
 * city's name alone.
 */
function linkByName(
  candidates: TransitStop[],
  lat: number,
  lng: number,
  name: string,
): TransitStop[] {
  const normVariants = getQueryVariants(name)
    .map((v) => normalizeLinkName(v))
    .filter((v, i, arr) => v.length > 0 && arr.indexOf(v) === i);

  // First-pass candidates: distance + fuzzy name match against any query variant.
  const prelim = candidates.filter((stop) => {
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
  if (prelim.length === 0) return [];

  // Second-pass pruning: avoid linking by city token only.
  // Keep candidates that share at least one informative token from the place
  // name variants (tokens present in some, but not all, prelim candidates).
  // Tokens are compared in expanded form, so "Köln Hbf" shares "hauptbahnhof"
  // with a place or stop spelled "Köln Hauptbahnhof".
  const tokenFreq = new Map<string, number>();
  const prelimTokenSets = prelim.map((s) => new Set(tokenizeLinkName(expandSearchQuery(s.name))));
  for (const tokens of prelimTokenSets) {
    for (const t of tokens) {
      tokenFreq.set(t, (tokenFreq.get(t) ?? 0) + 1);
    }
  }

  const placeTokens = new Set<string>();
  for (const q of normVariants) {
    for (const t of tokenizeLinkName(expandSearchQuery(q))) {
      if (t.length < MIN_INFORMATIVE_TOKEN_LEN) continue;
      if (/^\d+$/.test(t)) continue;
      placeTokens.add(t);
    }
  }

  const informativeTokens = Array.from(placeTokens).filter((t) => {
    const count = tokenFreq.get(t) ?? 0;
    return count > 0 && count < prelim.length;
  });

  return informativeTokens.length === 0
    ? prelim
    : prelim.filter((_, i) => informativeTokens.some((t) => prelimTokenSets[i].has(t)));
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
  options: PlaceTransitOptions = {},
): PlaceTransit {
  const cache = ctx.cache;

  /** The OSM object's local name, cached like the links; unknown when the lookup fails. */
  async function localNameOf(osmRef: string | undefined): Promise<string | undefined> {
    const lookup = options.lookupLocalName;
    if (!lookup || !osmRef || !OSM_REF.test(osmRef)) return undefined;
    try {
      const found = await cache.withCache<{ name?: string }>(
        hashKey("transit:osm-local-name", { osmRef }),
        TTL.placeStops,
        async () => {
          const name = (await lookup(osmRef))?.trim();
          return name ? { name } : {};
        },
      );
      return found.name;
    } catch {
      return undefined;
    }
  }

  async function linkFor(place: PlaceQuery): Promise<PlaceLink> {
    const placeName = (await localNameOf(place.osmRef)) ?? place.name;
    const names: string[] = [];
    for (const name of [placeName, place.stopName]) {
      if (name && !names.some((n) => canonicalLinkName(n) === canonicalLinkName(name)))
        names.push(name);
    }
    return {
      lat: place.lat,
      lng: place.lng,
      names,
      placeName,
      openedFor: place.stopName,
      cacheId: placeCacheId(place.lat, place.lng, names, place.placeId),
    };
  }

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
  async function getLinkedStops(place: PlaceQuery): Promise<MobilityResult<TransitStop[]>> {
    return linkedStops(await linkFor(place));
  }

  async function linkedStops(link: PlaceLink): Promise<MobilityResult<TransitStop[]>> {
    const id = link.cacheId;
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
        const discovered = await discoverLinkedStops(link.lat, link.lng, link.names);
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
    names: string[],
  ): Promise<CachedStopsEnvelope> {
    // Scope dynamic providers to a ~1 degree buffer around the place (approx 100 km) so that
    // providers from distant regions don't contribute stops that share stop-database
    // IDs but would then return their own regional routes via getRoutesForStop.
    const buf = 1.0;
    const placeBbox: BBox = [lng - buf, lat - buf, lng + buf, lat + buf];
    // Search with all synonym variants (e.g. "Hbf" + "Hauptbahnhof") so that
    // providers indexing either form are found, then deduplicate by stop id.
    const variants = [...new Set(names.flatMap((name) => getQueryVariants(name)))];
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
    // Each name links the stops it would link alone, e.g. the station's local
    // name and the name of the stop the place was opened for.
    const kept = new Set(names.flatMap((name) => linkByName(raw, lat, lng, name)));
    const linked = raw.filter((stop) => kept.has(stop));
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
  async function getMergedRoutes(place: PlaceQuery): Promise<MobilityResult<MergedRoute[]>> {
    const link = await linkFor(place);
    const cacheId = link.cacheId;
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

    const stopsRes = await linkedStops(link);
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
    const partialRoutes = partialLookups(routeResults, "route");

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
    const freshness = withPartial(mergeFreshness(...allFresh), partialRoutes);
    const envelope: CachedRoutes = { routes: merged, attributions, freshness };
    await cache.set(key, envelope, cacheTtl(envelope.freshness, TTL.placeRoutes));
    return { data: merged, attributions, freshness };
  }

  // Timetable merging (shared by departures & arrivals)

  /**
   * Merge departures/arrivals from all linked stops, folding each provider's
   * copy of one departure into a single row.
   *
   * Candidate rows are found by keys in the departure's 2-minute bucket and the
   * neighbouring one:
   *   line:     normalizedShortName + bucket
   *   headsign: normalizedHeadsign + bucket (+ platform when known)
   * A key only proposes candidates. A row absorbs a departure when it is
   * plausibly the same one: rows from the same source merge only for the same
   * trip, a line match also needs a compatible headsign (the two directions of a
   * line stay apart), and a headsign match also needs a compatible line. Of
   * several candidates, the one closest in time wins, so a frequent line keeps
   * one row per departure.
   *
   * Each row names the stop it leaves from, and is marked when that is not the
   * place's main stop (see {@link nameRowStops}), and the platform most likely
   * right (see {@link choosePlatform}).
   *
   * Not cached — caller refetches every 30s for real-time data.
   */
  async function buildMergedTimetable(
    stops: TransitStop[],
    fetchFn: (stopId: string, minutes: number) => Promise<MobilityResult<Departure[]>>,
    minutes: number,
    placeName: string,
    openedFor?: string,
  ): Promise<MobilityResult<MergedDeparture[]>> {
    if (stops.length === 0) return emptyResult<MergedDeparture[]>([], { hasRealtimeData: true });

    const results = await Promise.allSettled(stops.map((s) => fetchFn(s.id, minutes)));
    // A transport failure must not replace a cached timetable with a successful empty result.
    const partial = partialLookups(results, "timetable");
    const rows: MergedDeparture[] = [];
    const byKey = new Map<string, MergedDeparture[]>();
    // The stop, linked-stop provider and trip id of every departure folded into a row.
    const folded = new Map<MergedDeparture, FoldedDeparture[]>();
    const allFresh: Freshness[] = [];

    function register(row: MergedDeparture, keys: string[]): void {
      for (const key of keys) {
        const rows = byKey.get(key);
        if (!rows) byKey.set(key, [row]);
        else if (!rows.includes(row)) rows.push(row);
      }
    }

    function isSameDeparture(
      row: MergedDeparture,
      dep: DepartureWithFeed,
      stopProvider: string,
      matchedBy: "line" | "headsign",
    ): boolean {
      const parts = folded.get(row) ?? [];
      // The same trip seen at two linked stops, e.g. a station and its platform.
      if (dep.tripId && parts.some((part) => part.tripId === dep.tripId)) return true;
      const fromSameSource = parts.filter((part) => part.provider === stopProvider);
      if (fromSameSource.length > 0) {
        // Another row of the same source is another departure, such as the
        // next train of a frequent line, unless it repeats one: some sources
        // list a train twice under two trip ids (RMV's "RE1" and "RE 1 (RR").
        return fromSameSource.some((part) => repeats(part, dep));
      }
      return matchedBy === "line"
        ? headsignsCompatible(row.headsign, dep.headsign)
        : lineNamesCompatible(row.route.shortName, dep.route.shortName);
    }

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
        // Line keys, then headsign keys ("trip:"-prefixed) for one bucket.
        const keysIn = (bucket: string) => [
          `${normShort}:${bucket}`,
          ...(normHeadsign && dep.platform
            ? [`trip:${normHeadsign}:${bucket}:${dep.platform}`]
            : []),
          ...(normHeadsign ? [`trip:${normHeadsign}:${bucket}`] : []),
        ];
        const ownKeys = keysIn(bucket0);
        const lookupKeys = [...ownKeys, ...keysIn(bucket1)];

        const scheduled = Date.parse(dep.scheduledAt);
        let existing: MergedDeparture | undefined;
        let distance = Number.POSITIVE_INFINITY;
        for (const key of lookupKeys) {
          const matchedBy = key.startsWith("trip:") ? "headsign" : "line";
          for (const row of byKey.get(key) ?? []) {
            const gap = Math.abs(Date.parse(row.scheduledAt) - scheduled);
            if (gap >= distance || !isSameDeparture(row, dep, stopProvider, matchedBy)) continue;
            existing = row;
            distance = gap;
          }
        }

        const part: FoldedDeparture = {
          stop: departureStop(dep, stops[i]),
          provider: stopProvider,
          tripId: dep.tripId ?? "",
          scheduledAt: dep.scheduledAt,
          line: dep.route.shortName,
          headsign: dep.headsign,
          platform: dep.scheduledPlatform ?? dep.platform,
          departure: dep,
        };
        if (!existing) {
          const entry: MergedDeparture = {
            ...dep,
            providers: feedProviders.length ? [...feedProviders] : [providerName],
            tripIds: dep.tripId ? [dep.tripId] : [],
          };
          rows.push(entry);
          folded.set(entry, [part]);
          // Register under the departure's own bucket; the neighbour is for lookup only.
          register(entry, ownKeys);
        } else {
          // Alias keys let later lookups from either bucket find this row.
          register(existing, lookupKeys);
          folded.get(existing)?.push(part);
          mergeInto(existing, dep, feedProviders.length ? feedProviders : [providerName]);
        }
      }
    }

    for (const row of rows) choosePlatform(row, folded.get(row) ?? []);
    nameRowStops(
      rows.map((row) => ({ row, stops: (folded.get(row) ?? []).map((part) => part.stop) })),
      placeName,
      openedFor,
    );
    const unique = rows.sort(
      (a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime(),
    );
    return {
      data: unique,
      attributions: contributorsForRecords(unique),
      freshness: withPartial(mergeFreshness(...allFresh), partial),
    };
  }

  async function getMergedDepartures(
    place: PlaceQuery,
    minutes: number,
  ): Promise<MobilityResult<MergedDeparture[]>> {
    const link = await linkFor(place);
    const stopsRes = await linkedStops(link);
    const merged = await buildMergedTimetable(
      stopsRes.data,
      (id, min) => orchestrator.getDepartures(id, min),
      minutes,
      link.placeName,
      link.openedFor,
    );
    return {
      data: merged.data,
      // Attribute only the timetable results, not the stop-search fan-out.
      attributions: merged.attributions,
      freshness: mergeFreshness(stopsRes.freshness, merged.freshness),
    };
  }

  async function getMergedArrivals(
    place: PlaceQuery,
    minutes: number,
  ): Promise<MobilityResult<MergedDeparture[]>> {
    const link = await linkFor(place);
    const stopsRes = await linkedStops(link);
    const merged = await buildMergedTimetable(
      stopsRes.data,
      (id, min) => orchestrator.getArrivals(id, min),
      minutes,
      link.placeName,
      link.openedFor,
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
  async function getMergedAlerts(place: PlaceQuery): Promise<MobilityResult<ServiceAlert[]>> {
    const link = await linkFor(place);
    interface CachedAlerts {
      alerts: ServiceAlert[];
      attributions: Attribution[];
      freshness: Freshness;
    }
    const cacheId = link.cacheId;
    const key = hashKey("transit:place-alerts", { id: cacheId });
    const cached = await cache.get<CachedAlerts>(key);
    if (cached) {
      return {
        data: cached.alerts,
        attributions: cached.attributions,
        freshness: cached.freshness,
      };
    }

    const stopsRes = await linkedStops(link);
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
    const partialAlerts = partialLookups(alertResults, "alert");
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
    const freshness = withPartial(mergeFreshness(...allFresh), partialAlerts);
    const envelope: CachedAlerts = { alerts: merged, attributions, freshness };
    await cache.set(key, envelope, cacheTtl(envelope.freshness, TTL.placeAlerts));
    return { data: merged, attributions, freshness };
  }

  // Facility merging

  /**
   * Fetch facilities for all linked stops and deduplicate by facility id.
   * Cached 24 hours.
   */
  async function getMergedFacilities(place: PlaceQuery): Promise<MobilityResult<Facility[]>> {
    const link = await linkFor(place);
    interface CachedFacilities {
      facilities: Facility[];
      attributions: Attribution[];
      freshness: Freshness;
    }
    const cacheId = link.cacheId;
    const key = hashKey("transit:place-facilities", { id: cacheId });
    const cached = await cache.get<CachedFacilities>(key);
    if (cached) {
      return {
        data: cached.facilities,
        attributions: cached.attributions,
        freshness: cached.freshness,
      };
    }

    const stopsRes = await linkedStops(link);
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
    const partialFacilities = partialLookups(facResults, "facility");
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
    const freshness = withPartial(mergeFreshness(...allFresh), partialFacilities);
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
