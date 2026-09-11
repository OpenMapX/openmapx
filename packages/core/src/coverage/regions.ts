import type { RegionKey, RegionRelation, StreamRegionEvidence, Wgs84Bounds } from "./types";

export interface RegionDescriptor {
  key: RegionKey;
  aliases?: readonly string[];
  bounds?: Wgs84Bounds;
}

export interface RegionRelationResult {
  relation: RegionRelation;
  reason: "key" | "bounds" | "unknown" | "invalid";
}

function validLatitude(value: number): boolean {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

function validLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

/**
 * Validate a WGS84 box. A west value greater than east is a valid dateline
 * crossing and is intentionally represented as two longitude intervals.
 */
export function isValidWgs84Bounds(bounds: readonly number[]): bounds is Wgs84Bounds {
  if (bounds.length !== 4) return false;
  const [west, south, east, north] = bounds;
  return (
    validLongitude(west) &&
    validLongitude(east) &&
    validLatitude(south) &&
    validLatitude(north) &&
    south < north &&
    west !== east
  );
}

function longitudeIntervals(bounds: Wgs84Bounds): Array<[number, number]> {
  const [west, , east] = bounds;
  return west < east
    ? [[west, east]]
    : [
        [west, 180],
        [-180, east],
      ];
}

function intervalOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

function containsLongitude(outer: Wgs84Bounds, inner: Wgs84Bounds): boolean {
  return longitudeIntervals(inner).every((innerInterval) =>
    longitudeIntervals(outer).some(
      (outerInterval) =>
        outerInterval[0] <= innerInterval[0] && outerInterval[1] >= innerInterval[1],
    ),
  );
}

function overlapsBounds(a: Wgs84Bounds, b: Wgs84Bounds): boolean {
  const [, southA, , northA] = a;
  const [, southB, , northB] = b;
  if (northA <= southB || northB <= southA) return false;
  return longitudeIntervals(a).some((aInterval) =>
    longitudeIntervals(b).some((bInterval) => intervalOverlap(aInterval, bInterval)),
  );
}

function sameBounds(a: Wgs84Bounds, b: Wgs84Bounds): boolean {
  return a.every((value, index) => value === b[index]);
}

function normalizedKeys(region: RegionDescriptor): Set<string> {
  return new Set([region.key, ...(region.aliases ?? [])]);
}

/**
 * Relate source evidence to a selected region. Exact named associations win;
 * geometry is only used when both boxes are valid and never implies a full
 * political-region claim from a provider's country or source id.
 */
export function relateRegions(
  selected: RegionDescriptor,
  source: Pick<StreamRegionEvidence, "keys" | "bounds">,
): RegionRelationResult {
  const selectedKeys = normalizedKeys(selected);
  if (source.keys.some((key) => selectedKeys.has(key))) {
    return { relation: "exact", reason: "key" };
  }

  // Different IDs alone do not imply disjointness: extracts and declared
  // scopes can overlap or nest. Use geometry when both sides supply it.
  if (selected.bounds && !isValidWgs84Bounds(selected.bounds)) {
    return { relation: "unknown", reason: "invalid" };
  }
  if (source.bounds && !isValidWgs84Bounds(source.bounds)) {
    return { relation: "unknown", reason: "invalid" };
  }
  if (!selected.bounds || !source.bounds) return { relation: "unknown", reason: "unknown" };
  if (!overlapsBounds(selected.bounds, source.bounds)) {
    return { relation: "disjoint", reason: "bounds" };
  }
  if (sameBounds(selected.bounds, source.bounds)) return { relation: "exact", reason: "bounds" };
  if (containsBounds(source.bounds, selected.bounds)) {
    return { relation: "contains", reason: "bounds" };
  }
  return { relation: "intersects", reason: "bounds" };
}

function containsBounds(outer: Wgs84Bounds, inner: Wgs84Bounds): boolean {
  const [, southOuter, , northOuter] = outer;
  const [, southInner, , northInner] = inner;
  return southOuter <= southInner && northOuter >= northInner && containsLongitude(outer, inner);
}

export function regionKeyForExtract(id: string): RegionKey {
  return `extract:${id}`;
}

export function regionKeyForCountry(code: string): RegionKey {
  return `country:${code.trim().toUpperCase()}`;
}

export function isCountryRegionKey(key: string): boolean {
  return /^country:[A-Z]{2,3}$/.test(key);
}

export function isExtractRegionKey(key: string): boolean {
  return key.startsWith("extract:") && key.length > "extract:".length;
}
