import {
  dataSourceToAttribution,
  type IntegrationDataSource,
  narrowContributors,
  parseContributors,
  snapshotContributors,
} from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";

/** Merge captured credits, retaining distinct mandatory notices and immutable copies. */
export function mergeAttributions(...groups: readonly (readonly Attribution[])[]): Attribution[] {
  return snapshotContributors(...groups);
}

export interface DataSourceRecordCredits {
  source?: string;
  sources?: readonly string[];
  contributors?: readonly Attribution[];
  attributions?: Attribution[];
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
  return snapshotContributors(
    matched,
    declared.map(dataSourceToAttribution),
    snapshotContributors(record.attributions ?? []),
  );
}

export interface DataSourceLayerCreditsInput {
  sourceLabel: string;
  dataSources: IntegrationDataSource[];
  envelope: Attribution[];
  results: DataSourceRecordCredits[];
  isFetching: boolean;
  warn?: (message: string) => void;
}

/** Only final retained records contribute; fetch state never clears captured visible data. */
export function dataSourceLayerCredits(input: DataSourceLayerCreditsInput): Attribution[] {
  const credits = snapshotContributors(
    ...input.results.map((record) =>
      dataSourceRecordContributors(record, input.envelope, input.dataSources),
    ),
  );
  if (input.warn && input.results.length > 0) {
    const sourceIds = new Set(credits.map((receipt) => receipt.sourceId));
    const names = new Set(credits.map((receipt) => receipt.name));
    const unresolved = input.envelope.filter(
      (receipt) => !sourceIds.has(receipt.sourceId) && !names.has(receipt.name),
    );
    if (unresolved.length)
      input.warn(
        `[DataSourceLayer] envelope.attributions for "${input.sourceLabel}" do not belong to retained records: ${unresolved.map((receipt) => receipt.sourceId).join(", ")}`,
      );
  }
  return credits;
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

/** Minimal slice of `IntegrationRegistry` for `attributionsForSources`. */
export interface DataSourceResolver {
  findDataSource(sourceId: string): IntegrationDataSource | undefined;
}

/**
 * Resolve structured attribution for the provider(s) that actually served a
 * result — the single client-side path for the surfaces that learn their
 * source from the response payload (geocoding `SearchResult.provider`, routing
 * `data.provider`) rather than from "which providers of this domain are
 * healthy".
 *
 * Pass the integration ID(s) the response reported as having served the data;
 * each is looked up in the registry and its `dataSources` mapped to
 * `Attribution` via the canonical {@link dataSourceToAttribution}. The result
 * is deduped by `sourceId` (first seen wins) and fed straight into
 * `<AttributionStrip>`. Unknown/empty IDs are skipped, so a caller can pass
 * `data?.provider` without guarding.
 *
 * This is deliberately keyed on the served provider, never on a domain — that
 * is what keeps attribution "as much as necessary, not too much": a healthy
 * fallback provider that did not serve the request gets no credit here (it is
 * still disclosed on the capability-scoped /terms + /privacy pages).
 */
export function attributionsForProviders(
  registry: ProviderMetaResolver,
  providerIds: Iterable<string | null | undefined>,
): Attribution[] {
  const seen = new Set<string>();
  const out: Attribution[] = [];
  for (const id of providerIds) {
    if (!id) continue;
    const meta = registry.get(id);
    if (!meta?.dataSources) continue;
    for (const ds of meta.dataSources) {
      if (seen.has(ds.sourceId)) continue;
      seen.add(ds.sourceId);
      out.push(dataSourceToAttribution(ds));
    }
  }
  return out;
}

/**
 * Like {@link attributionsForProviders} but keyed on manifest `sourceId`s
 * rather than integration ids — for surfaces whose response payload reports the
 * served source by its `sourceId` (e.g. a review's `source`). Resolves each id
 * via `registry.findDataSource`; an unknown id resolves to nothing (no credit),
 * so it never falls back to crediting an entire domain. Deduped, first seen
 * wins.
 */
export function attributionsForSources(
  registry: DataSourceResolver,
  sourceIds: Iterable<string | null | undefined>,
): Attribution[] {
  const seen = new Set<string>();
  const out: Attribution[] = [];
  for (const id of sourceIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const ds = registry.findDataSource(id);
    if (ds) out.push(dataSourceToAttribution(ds));
  }
  return out;
}
