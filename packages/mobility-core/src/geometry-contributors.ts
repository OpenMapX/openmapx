import {
  type ContributingRecord,
  contributorsForField,
  type FieldContributors,
  parseContributors,
  snapshotContributors,
} from "./contributors";

/** Inclusive vertex indices; adjacent spans share their boundary vertex. */
export interface GeometryContributorSpan extends ContributingRecord {
  startIndex: number;
  endIndex: number;
}

/** Present spans are authoritative. Uncovered edges have unknown ownership. */
export function parseGeometryContributors(
  value: unknown,
  pointCount: number,
): GeometryContributorSpan[] | undefined {
  if (!Array.isArray(value)) return undefined;
  let previousEnd = 0;
  const spans: GeometryContributorSpan[] = [];
  for (const raw of value) {
    if (
      !raw ||
      !Number.isInteger(raw.startIndex) ||
      !Number.isInteger(raw.endIndex) ||
      raw.startIndex < previousEnd ||
      raw.endIndex <= raw.startIndex ||
      raw.endIndex >= pointCount
    )
      return undefined;
    const contributors = parseContributors(raw.contributors);
    if (contributors === undefined) return undefined;
    spans.push({
      startIndex: raw.startIndex,
      endIndex: raw.endIndex,
      contributors: snapshotContributors(contributors),
    });
    previousEnd = raw.endIndex;
  }
  return spans;
}

/** Complete partition of actual edges, with copied receipts and explicit unknown gaps.
 * No current catalogue lookup is permitted for retained/historical geometry.
 */
export function captureGeometryContributors(
  route: ContributingRecord & {
    fieldContributors?: FieldContributors;
    geometry: readonly unknown[];
    geometryContributors?: readonly GeometryContributorSpan[];
  },
): GeometryContributorSpan[] {
  const endIndex = route.geometry.length - 1;
  if (endIndex < 1) return [];
  if (route.geometryContributors === undefined)
    return [{ startIndex: 0, endIndex, contributors: contributorsForField(route, "geometry") }];
  const spans = parseGeometryContributors(route.geometryContributors, route.geometry.length) ?? [];
  const result: GeometryContributorSpan[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.startIndex > cursor)
      result.push({ startIndex: cursor, endIndex: span.startIndex, contributors: [] });
    result.push(span);
    cursor = span.endIndex;
  }
  if (cursor < endIndex) result.push({ startIndex: cursor, endIndex, contributors: [] });
  return result;
}
