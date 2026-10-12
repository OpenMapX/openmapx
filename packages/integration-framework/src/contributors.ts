import type { Attribution } from "@openmapx/mobility-core/attribution";
import { parseContributors, snapshotContributors } from "@openmapx/mobility-core/contributors";

export {
  type ContributingRecord,
  contributorKey,
  contributorsForFields,
  contributorsForRecords,
  type FieldContributors,
  legacyAttributionsToContributors,
  narrowContributors,
  parseContributors,
  parseFieldContributors,
  serializeContributors,
  snapshotContributors,
  withContributors,
  withFeatureContributors,
} from "@openmapx/mobility-core/contributors";

/** Resolve only explicitly supplied source identities. Unknown IDs never expand. */
export function resolveSourceContributors(
  sourceIds: Iterable<string>,
  resolve: (sourceId: string) => Attribution | undefined,
): Attribution[] {
  return snapshotContributors(
    Array.from(new Set(sourceIds)).flatMap((sourceId) => resolve(sourceId) ?? []),
  );
}

/** A portable captured receipt or explicitly identified legacy contribution. */
export interface ContributorEvidence {
  contributors?: unknown;
  sourceIds?: Iterable<string>;
}

/** Never substitute an integration/domain manifest for missing item provenance. */
export function resolveContributors(
  evidence: ContributorEvidence,
  resolve: (sourceId: string) => Attribution | undefined,
): Attribution[] {
  const captured = parseContributors(evidence.contributors);
  return captured === undefined
    ? resolveSourceContributors(evidence.sourceIds ?? [], resolve)
    : snapshotContributors(captured);
}
