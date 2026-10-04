import {
  type DataSourceAttribution,
  dataSourceToAttribution,
  type IntegrationDataSource,
} from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";

/** Merge response-scoped attribution groups, preserving the first credit for each source. */
export function mergeAttributions(...groups: Attribution[][]): Attribution[] {
  const seen = new Set<string>();
  const merged: Attribution[] = [];
  for (const group of groups) {
    for (const attribution of group) {
      if (!attribution.sourceId || seen.has(attribution.sourceId)) continue;
      seen.add(attribution.sourceId);
      merged.push(attribution);
    }
  }
  return merged;
}

/**
 * Map a provider's per-record runtime attribution ({@link DataSourceAttribution}
 * — e.g. France IRVE's per-station Licence-Ouverte publisher credit, an EV
 * charge stop's upstream OCM data provider) onto the shared {@link Attribution}
 * shape consumed by `<AttributionStrip>`. Shared by `DataSourceLayer` (map
 * strip) and `EvPlanCard` (per-stop credit) so the mapping lives in one place.
 */
export function runtimeAttributionToAttribution(attr: DataSourceAttribution): Attribution {
  return {
    sourceId: attr.text || attr.url,
    name: attr.text,
    url: attr.url,
    spdxLicense: attr.license,
    licenseUrl: attr.licenseUrl,
  };
}

export interface DataSourceLayerCreditsInput {
  /** The active data source id, for the diagnostic message. */
  sourceLabel: string;
  /** The integration manifest's declared sources (may be empty). */
  dataSources: IntegrationDataSource[];
  /** The search envelope's attributions. */
  envelope: Attribution[];
  /** The visible results; their per-record `attributions` are credited too. */
  results: { attributions?: DataSourceAttribution[] }[];
  /** Whether the search is in flight. */
  isFetching: boolean;
  /** Receives a diagnostic for credits nothing can render; omit to stay silent. */
  warn?: (message: string) => void;
}

/**
 * The credits the map strip shows for a data-source layer.
 *
 * Manifest-declared sources are narrowed to those the envelope credited (or,
 * when the envelope credited none, all of them — but only while results are
 * visible). Per-record `result.attributions` are first-class credits beside
 * them: an aggregating integration (e.g. `fuel`, which orchestrates providers
 * and declares no sources itself) credits each record's sources this way.
 * While the first response is in flight nothing is credited, so a freshly
 * selected layer never flashes every declared publisher.
 */
export function dataSourceLayerCredits(input: DataSourceLayerCreditsInput): Attribution[] {
  const { dataSources, envelope, results } = input;
  if (input.isFetching && envelope.length === 0) return [];

  const creditedIds = new Set(envelope.map((a) => a.sourceId));
  const filtered = dataSources.filter((ds) => creditedIds.has(ds.sourceId));
  const creditedSources = filtered.length > 0 ? filtered : results.length > 0 ? dataSources : [];
  const manifestCredits = creditedSources.map(dataSourceToAttribution);

  const seen = new Set(manifestCredits.map((a) => a.sourceId));
  const runtimeCredits: Attribution[] = [];
  for (const result of results) {
    for (const attr of result.attributions ?? []) {
      const credit = runtimeAttributionToAttribution(attr);
      if (seen.has(credit.sourceId)) continue;
      seen.add(credit.sourceId);
      runtimeCredits.push(credit);
    }
  }

  if (filtered.length === 0 && input.warn) {
    // An envelope credit is rendered when the manifest declares it or a
    // record carries it; flag only the ones neither does.
    const perRecord = new Set(runtimeCredits.map((c) => c.name));
    const unrendered = envelope.filter((a) => !perRecord.has(a.name)).map((a) => a.sourceId);
    if (unrendered.length > 0) {
      input.warn(
        `[DataSourceLayer] envelope.attributions for "${input.sourceLabel}" reference sourceIds ` +
          `not declared in the integration manifest: ${unrendered.join(", ")}`,
      );
    }
  }

  return [...manifestCredits, ...runtimeCredits];
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
