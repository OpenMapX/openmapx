import {
  type ContributingRecord,
  captureResultContributors,
  contributorsForRecords,
  readCapturedFieldContributors,
  snapshotContributors,
} from "./contributors";
import type { Attribution } from "./types/attribution.js";

/** Known transit DTO containers. Geometry arrays and scalar values are not suppliers. */
const TRANSIT_CHILDREN = [
  "segments",
  "itinerary",
  "alternatives",
  "itineraries",
  "legs",
  "stops",
  "alerts",
  "remarks",
  "vehicles",
  "platforms",
  "parentStops",
  "childStops",
  "accessibility",
  "amenities",
  "facilities",
  "transfers",
  "fare",
  "formationDetails",
  "parking",
  "canonicalStop",
  "requestedStop",
  "parentStop",
  "siblingStops",
  "geometry",
  "stopArea",
  "fareZones",
  "facts",
  "topographicPlace",
  "stationIntelligence",
  "from",
  "to",
  "route",
  "stop",
  "seeds",
  "products",
  "results",
] as const;

/** Capture provider response records, retaining exact item evidence in mixed backends.
 * Uniform response metadata certifies legacy untagged rows only when one source
 * actually supplied the response. Present receipts, including [], always win.
 */
export function captureTransitContributors<T>(data: T, envelope: readonly Attribution[]): T {
  if (Array.isArray(data)) return data.map((row) => captureTransitContributors(row, envelope)) as T;
  if (!data || typeof data !== "object") return data;
  const original = data as Record<string, unknown> & ContributingRecord;
  const result = { ...original };
  if (original.fieldContributors !== undefined)
    result.fieldContributors = readCapturedFieldContributors(original.fieldContributors) ?? {};
  for (const key of TRANSIT_CHILDREN) {
    if (original[key] !== undefined)
      result[key] = captureTransitContributors(original[key], envelope);
  }
  // The historic infrastructure DTO calls its native stop reference sourceId;
  // that field is entity identity, not contributor evidence. Its trusted
  // uniform acquisition receipt still certifies the serving API.
  const nativeInfrastructureId =
    "canonicalStop" in original && "focusLevel" in original && "stopId" in original;
  const own = captureResultContributors(
    {
      ...original,
      ...(typeof original.sourceId === "string" && !nativeInfrastructureId
        ? { sourceIds: [original.sourceId] }
        : {}),
    },
    envelope,
  );
  // An itinerary/plan/journey also represents the retained children's contribution.
  const retained = [
    "segments",
    "itinerary",
    "itineraries",
    "legs",
    "stops",
    "fare",
    "formationDetails",
  ].flatMap((key) =>
    Array.isArray(result[key]) ? result[key] : result[key] ? [result[key]] : [],
  ) as ContributingRecord[];
  result.contributors =
    original.contributors !== undefined
      ? own
      : snapshotContributors(own, contributorsForRecords(retained));
  return result as T;
}

export function transitDataContributors(data: unknown): Attribution[] {
  return contributorsForRecords((Array.isArray(data) ? data : [data]) as ContributingRecord[]);
}
