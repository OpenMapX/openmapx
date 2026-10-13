import { dataSourceToAttribution } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  type ContributingRecord,
  contributorsForRecords,
  parseContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import type { ProviderMetaResolver } from "@/lib/attributionForProviders";

/** What a response says about who served one item. */
export interface ServedBy extends ContributingRecord {
  provider?: string | null;
  contributingProviders?: readonly string[];
  /** Manifest sourceIds of the backend(s) that answered, when reported. */
  sourceIds?: readonly string[];
}

/** Captured receipts take precedence; legacy resolution uses named identities.
 * A legacy single-source provider can establish its one uniform supplier when
 * no source IDs were reported. Missing multi-backend evidence never expands.
 */
export function servedAttributions(
  registry: ProviderMetaResolver,
  served: Iterable<ServedBy | null | undefined>,
): Attribution[] {
  return contributorsForRecords(
    (function* () {
      for (const item of served) {
        if (!item) continue;
        const captured = parseContributors(item.contributors);
        if (captured !== undefined) {
          yield { contributors: captured };
          continue;
        }
        const receipts: Attribution[] = [];
        for (const provider of new Set([item.provider, ...(item.contributingProviders ?? [])])) {
          if (!provider) continue;
          const declared = registry.get(provider)?.dataSources ?? [];
          const proven =
            item.sourceIds === undefined
              ? declared.length === 1
                ? declared
                : []
              : declared.filter((source) => item.sourceIds?.includes(source.sourceId));
          receipts.push(...proven.map(dataSourceToAttribution));
        }
        yield { contributors: snapshotContributors(receipts) };
      }
    })(),
  );
}
