import {
  dataSourceToAttribution,
  type IntegrationDataSource,
  narrowContributors,
  parseContributors,
  snapshotContributors,
} from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";

export interface DataSourceRecordCredits {
  source?: string;
  sources?: readonly string[];
  contributors?: readonly Attribution[];
}

/** Capture an exact legacy record at the response boundary. Unknown IDs never expand. */
export function dataSourceRecordContributors(
  record: DataSourceRecordCredits,
  envelope: readonly Attribution[],
  dataSources: readonly IntegrationDataSource[],
): Attribution[] {
  const captured = parseContributors(record.contributors);
  if (captured !== undefined) return snapshotContributors(captured);
  const sourceIds = new Set(record.sources ?? (record.source ? [record.source] : []));
  const matched = narrowContributors(envelope, sourceIds);
  const matchedIds = new Set(matched.map((receipt) => receipt.sourceId));
  const declared = dataSources.filter(
    (source) => sourceIds.has(source.sourceId) && !matchedIds.has(source.sourceId),
  );
  return snapshotContributors(matched, declared.map(dataSourceToAttribution));
}

/**
 * Minimal slice of `IntegrationRegistry` this helper depends on. Keeping it
 * structural (rather than importing the class) makes the helper trivially
 * testable with a plain object and avoids a hard dependency on the registry
 * implementation. Satisfied by the real `IntegrationRegistry`.
 */
export interface ProviderMetaResolver {
  get(id: string): { dataSources?: IntegrationDataSource[] } | undefined;
}
