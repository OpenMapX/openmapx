import {
  type ContributingRecord,
  contributorsForRecords,
  parseFieldContributors,
  snapshotContributors,
} from "./contributors.js";
import { decodeMotisLineReference, decodeMotisRoutePatternId } from "./motis-route-pattern-id.js";
import type { Attribution } from "./types/attribution.js";
import { freshnessNow } from "./types/freshness.js";
import { withAttribution } from "./types/result.js";
import type { TripItinerary, TripLeg } from "./types/transit.js";

/** Host supplies a captured index; the pure adapter owns no provider runtime. */
export interface MotisContributorIndex {
  getById(sourceId: string): Attribution | undefined;
  listMotisFeedTags(): string[];
}

interface MaybeStopShape {
  id?: unknown;
  stopId?: unknown;
  tripId?: unknown;
  routeId?: unknown;
  route?: unknown;
  legs?: unknown;
  itineraries?: unknown;
  stops?: unknown;
  from?: unknown;
  to?: unknown;
  intermediateStops?: unknown;
  seeds?: unknown;
  stop?: unknown;
}

/**
 * Strip the MOTIS instance prefix (`ms:` or `mo:`) from an id and find the
 * longest matching feed tag in `feedTagsByLength` where the remainder either
 * equals the tag or starts with `<tag>_`.
 *
 * MOTIS feed tags can themselves contain underscores (e.g.
 * `au-nsw_Transport-for-New-South-Wales-...`), so we cannot just split on the
 * first underscore — we must match against known tags, longest first.
 */
function feedTagFromId(id: string | undefined, feedTagsByLength: string[]): string | undefined {
  if (!id) return undefined;
  if (feedTagsByLength.length === 0) return undefined;
  const rest = id.replace(/^(ms:|mo:|mr:)/, "");
  for (const tag of feedTagsByLength) {
    if (rest === tag) return tag;
    if (rest.startsWith(`${tag}_`)) return tag;
  }
  return undefined;
}

/**
 * Walk an arbitrary MOTIS-derived response shape and collect every feed tag
 * embedded in stop/trip ids it carries. Deduplicated, insertion-ordered.
 *
 * `feedTagsByLength` should be the AttributionIndex's MOTIS feed-tag set
 * sorted longest-first so prefix matching is unambiguous. If empty, returns
 * an empty array; the caller preserves the unknown supplier as [].
 *
 * Supports: TransitStop, Departure, VehicleJourney, TripPlan, TripItinerary,
 * TripLeg, VehicleJourneyStop, VehiclePosition, and plain arrays of the above.
 * Anything it does not understand contributes zero tags.
 */
export function extractFeedTags(data: unknown, feedTagsByLength: string[]): string[] {
  const tags = new Set<string>();
  const visit = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object") return;
    const obj = node as MaybeStopShape & Record<string, unknown>;
    const candidateIds = [obj.id, obj.stopId, obj.tripId, obj.routeId];
    for (const candidate of candidateIds) {
      if (typeof candidate !== "string") continue;
      const pattern = decodeMotisRoutePatternId(candidate);
      if (pattern) {
        for (const routeId of pattern.r) {
          const tag = feedTagFromId(routeId, feedTagsByLength);
          if (tag) tags.add(tag);
        }
        continue;
      }
      const line = decodeMotisLineReference(candidate);
      if (line) {
        const tag = feedTagFromId(line.r, feedTagsByLength);
        if (tag) tags.add(tag);
        continue;
      }
      const tag = feedTagFromId(candidate, feedTagsByLength);
      if (tag) tags.add(tag);
    }
    if (Array.isArray(obj.legs)) visit(obj.legs);
    if (Array.isArray(obj.itineraries)) visit(obj.itineraries);
    if (Array.isArray(obj.stops)) visit(obj.stops);
    if (obj.route) visit(obj.route);
    if (obj.from) visit(obj.from);
    if (obj.to) visit(obj.to);
    if (Array.isArray(obj.intermediateStops)) visit(obj.intermediateStops);
    if (Array.isArray(obj.seeds)) visit(obj.seeds);
    if (obj.stop) visit(obj.stop);
  };
  visit(data);
  return Array.from(tags);
}

/**
 * Walk each itinerary leg and populate `leg.attributions` based on the feed
 * tags embedded in the leg's stop/trip ids. Leaves legs with no recognisable
 * feed tags unchanged (the trip-level envelope still credits the union).
 *
 * When `index` is missing or returns no feed tags, all legs pass through
 * untouched so single-feed planners and offline tests are behaviour-preserving.
 */
export function annotateLegsWithAttribution(
  itineraries: TripItinerary[],
  index: MotisContributorIndex | undefined,
): TripItinerary[] {
  if (!index) return itineraries;
  const tagsByLength = index.listMotisFeedTags().sort((a, b) => b.length - a.length);
  if (tagsByLength.length === 0) return itineraries;
  return itineraries.map((itin) => ({
    ...itin,
    legs: itin.legs.map((leg) => {
      const legTags = extractFeedTags(leg, tagsByLength);
      if (legTags.length === 0) return leg;
      const attributions: Attribution[] = [];
      for (const tag of legTags) {
        const attr = index.getById(tag);
        if (attr) attributions.push(attr);
      }
      if (attributions.length === 0) return leg;
      const next: TripLeg = {
        ...leg,
        attributions,
        contributors: snapshotContributors(attributions),
      };
      return next;
    }),
  }));
}

/**
 * Wrap a MOTIS-derived value with attributions resolved against the host's
 * AttributionIndex. Unrecognised references remain explicitly unknown;
 * a software licence is never substituted for missing timetable lineage.
 */
export function wrapMotisWithFeedAttribution<T>(
  data: T,
  index: MotisContributorIndex | undefined,
  isRealtime = false,
) {
  const tagsByLength = index?.listMotisFeedTags().sort((a, b) => b.length - a.length) ?? [];
  const capture = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(capture);
    if (!node || typeof node !== "object") return node;
    const original = node as Record<string, unknown>;
    const result = { ...original };
    if (original.fieldContributors !== undefined)
      result.fieldContributors = parseFieldContributors(original.fieldContributors) ?? {};
    for (const key of [
      "legs",
      "itineraries",
      "stops",
      "from",
      "to",
      "route",
      "alerts",
      "remarks",
      "fare",
      "seeds",
      "stop",
    ]) {
      if (original[key] !== undefined) result[key] = capture(original[key]);
    }
    // MOTIS transport references are decoded against the active known-file index;
    // unknown feed references remain explicitly unknown, never a manifest fallback.
    const matched = extractFeedTags(original, tagsByLength).flatMap(
      (tag) => index?.getById(tag) ?? [],
    );
    result.contributors =
      original.contributors !== undefined
        ? snapshotContributors(original.contributors as Attribution[])
        : snapshotContributors(matched);
    if (typeof original.arrivalSeconds === "number" && original.stop) {
      result.lineageComplete = false;
      result.fieldContributors = {
        lat: snapshotContributors(matched),
        lng: snapshotContributors(matched),
        stop: snapshotContributors(matched),
        arrivalSeconds: [],
      };
    }
    if (
      Array.isArray(original.seeds) ||
      (original.lattice && original.values) ||
      (original.queryTime && Array.isArray(original.results))
    )
      result.lineageComplete = false;
    // A route pattern's geometry can combine several feeds, while its visible
    // name/color/mode come from the first typed transport reference.
    const pattern = typeof original.id === "string" ? decodeMotisRoutePatternId(original.id) : null;
    if (pattern && original.fieldContributors === undefined) {
      const scalar = extractFeedTags({ routeId: pattern.r[0] }, tagsByLength).flatMap(
        (tag) => index?.getById(tag) ?? [],
      );
      result.fieldContributors = Object.fromEntries(
        ["shortName", "longName", "mode", "color", "textColor", "operatorName"].map((field) => [
          field,
          snapshotContributors(scalar),
        ]),
      );
      (result.fieldContributors as Record<string, Attribution[]>).geometry =
        snapshotContributors(matched);
    }
    return result;
  };
  const captured = capture(data) as T;
  const records = (Array.isArray(captured) ? captured : [captured]) as ContributingRecord[];
  return withAttribution(
    captured,
    contributorsForRecords(records),
    freshnessNow({ hasRealtimeData: isRealtime }),
  );
}
