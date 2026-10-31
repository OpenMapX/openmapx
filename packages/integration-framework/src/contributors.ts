import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  contributorsForRecords,
  readCapturedContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";

import type { IntegrationContext } from "./context";
import { dataSourceToAttribution } from "./manifest";

export {
  type ContributingRecord,
  captureFieldContributors,
  captureResultContributors,
  contributorKey,
  contributorsForField,
  contributorsForFields,
  contributorsForRecordFields,
  contributorsForRecords,
  type FieldContributors,
  narrowContributors,
  parseContributors,
  parseFieldContributors,
  readCapturedContributors,
  readCapturedFieldContributors,
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

/** A portable captured receipt or explicitly identified acquisition source. */
export interface ContributorEvidence {
  contributors?: unknown;
  sourceIds?: Iterable<string>;
}

/** Never substitute an integration/domain manifest for missing item provenance. */
export function resolveContributors(
  evidence: ContributorEvidence,
  resolve: (sourceId: string) => Attribution | undefined,
): Attribution[] {
  const captured = readCapturedContributors(evidence.contributors);
  return captured === undefined
    ? resolveSourceContributors(evidence.sourceIds ?? [], resolve)
    : snapshotContributors(captured);
}

/**
 * Credits as the credits of changed data: where what is shown was changed
 * from the source or derived from it, for the licences that ask a changed
 * version to say so (`Attribution.modified`).
 */
export function asModifiedContributors(credits: readonly Attribution[]): Attribution[] {
  return credits.map((credit) => ({ ...credit, modified: true as const }));
}

/** Capture exact built-in source IDs from their declared metadata or runtime feed index. */
export function resolveIntegrationContributors(
  ctx: Pick<IntegrationContext, "manifest" | "attributionIndex">,
  sourceIds: Iterable<string>,
): Attribution[] {
  return resolveSourceContributors(sourceIds, (id) => {
    const declared = ctx.manifest.dataSources?.find((source) => source.sourceId === id);
    return declared ? dataSourceToAttribution(declared) : ctx.attributionIndex?.getById(id);
  });
}

/** Immutable lookup metadata captured before an unknown-backend acquisition.
 * The catalogue is resolution evidence only. It must never be displayed wholesale.
 */
export interface CapturedContributorCatalogue {
  declaredByIntegration: ReadonlyMap<string, readonly Attribution[]>;
  runtimeById: ReadonlyMap<string, readonly Attribution[]>;
  hasRuntime: boolean;
}

export function captureIntegrationContributorCatalogue(
  ctx: Pick<IntegrationContext, "getIntegrationsByDomain" | "attributionIndex">,
  domain: string,
): CapturedContributorCatalogue {
  const declaredByIntegration = new Map<string, readonly Attribution[]>();
  for (const integration of ctx.getIntegrationsByDomain(domain)) {
    declaredByIntegration.set(
      integration.id,
      snapshotContributors((integration.manifest?.dataSources ?? []).map(dataSourceToAttribution)),
    );
  }
  const runtimeById = new Map<string, readonly Attribution[]>();
  for (const receipt of ctx.attributionIndex?.list?.() ?? []) {
    runtimeById.set(
      receipt.sourceId,
      snapshotContributors(runtimeById.get(receipt.sourceId) ?? [], [receipt]),
    );
  }
  return { declaredByIntegration, runtimeById, hasRuntime: ctx.attributionIndex !== undefined };
}

/** Resolve a result against acquisition-time metadata, never the live registry. */
export function resolveCapturedContributors(
  catalogue: CapturedContributorCatalogue,
  integrationId: string,
  evidence: ContributorEvidence,
  uniformDeclaredSupplier = false,
): Attribution[] {
  const captured = readCapturedContributors(evidence.contributors);
  if (captured !== undefined) return snapshotContributors(captured);
  const declared = catalogue.declaredByIntegration.get(integrationId) ?? [];
  const sourceIds =
    evidence.sourceIds ??
    (uniformDeclaredSupplier && declared.length === 1 ? [declared[0].sourceId] : []);
  return contributorsForRecords(
    Array.from(new Set(sourceIds), (id) => {
      const matching = declared.filter((receipt) => receipt.sourceId === id);
      return { contributors: matching.length ? matching : (catalogue.runtimeById.get(id) ?? []) };
    }),
  );
}
