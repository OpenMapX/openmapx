import type { Route } from "@openmapx/core";
import { withFeatureContributors } from "@openmapx/mobility-core/contributors";
import { captureGeometryContributors } from "@openmapx/mobility-core/geometry-contributors";

/** Actual painted chunks, shared by planning, navigation, alternatives and proposals.
 * Receipts travel with these features through asynchronous source replacement.
 */
export function routeGeometryFeatures<P extends Record<string, unknown>>(
  route: Pick<Route, "geometry" | "geometryContributors" | "contributors" | "fieldContributors">,
  properties: P,
) {
  return captureGeometryContributors(route).map((span, geometryPart) =>
    withFeatureContributors(
      {
        type: "Feature" as const,
        properties: {
          ...properties,
          geometryPart,
          startIndex: span.startIndex,
          endIndex: span.endIndex,
        },
        geometry: {
          type: "LineString" as const,
          coordinates: route.geometry.slice(span.startIndex, span.endIndex + 1),
        },
      },
      span.contributors ?? [],
    ),
  );
}

/** Keep legacy layer IDs for the single/full first chunk. */
export function routeSegmentLayerId(base: string, index: number): string {
  return index === 0 ? base : `${base}-${index}`;
}

/** Translate global Mercator progress to each independently painted span. */
export function routeSegmentProgress(
  span: { startIndex: number; endIndex: number },
  cumulative: readonly number[],
  total: number,
  progress: number,
): number {
  const start = cumulative[span.startIndex] ?? 0;
  const end = cumulative[span.endIndex] ?? 0;
  // Outside [0,1] is intentional: the entire span is remaining/traveled.
  return end > start ? (progress * total - start) / (end - start) : 0;
}
