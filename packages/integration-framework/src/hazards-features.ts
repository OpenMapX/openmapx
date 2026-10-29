import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  snapshotContributors,
  withFeatureContributors,
} from "@openmapx/mobility-core/contributors";
import type { ContributorEvidence } from "./contributors";

/**
 * Capture each hazard/environment feature before publication or last-good retention.
 * The caller supplies its adapter's exact source identities; collection metadata is
 * intentionally unavailable here. An existing record/worker receipt, including [],
 * takes precedence over resolving current source metadata.
 */
export function captureHazardFeatures<T extends { features: GeoJSON.Feature[] }>(
  collection: T,
  resolve: (evidence: ContributorEvidence) => readonly Attribution[],
  sourceIdsFor: (feature: T["features"][number]) => Iterable<string>,
): T {
  return {
    ...collection,
    features: collection.features.map((feature) => {
      const receipts = resolve({
        contributors: feature.properties?.contributors ?? feature.properties?._mapAttributions,
        sourceIds: sourceIdsFor(feature),
      });
      return withFeatureContributors(
        {
          ...feature,
          properties: {
            ...feature.properties,
            ...(feature.properties?.contributors === undefined
              ? {}
              : { contributors: snapshotContributors(receipts) }),
          },
        },
        receipts,
      );
    }),
  };
}
