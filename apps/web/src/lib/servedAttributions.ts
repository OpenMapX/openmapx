import { dataSourceToAttribution } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { ProviderMetaResolver } from "@/lib/attributionForProviders";

/** What a response says about who served one item. */
export interface ServedBy {
  provider?: string | null;
  contributingProviders?: readonly string[];
  /** Manifest sourceIds of the backend(s) that answered, when reported. */
  sourceIds?: readonly string[];
}

/**
 * Credits for items served by integrations that may front several backends
 * (routing-valhalla: self-hosted vs Stadia Maps; geocoding-photon: self-hosted
 * vs Komoot). Each provider's declared sources are narrowed to the reported
 * `sourceIds`; a provider none of whose sources was reported (e.g. a
 * conflated suggestion's other contributor) keeps all of its declared sources.
 * Resolution stays within each provider's own manifest, since other
 * integrations may reuse a sourceId. Deduped by sourceId, first seen wins.
 */
export function servedAttributions(
  registry: ProviderMetaResolver,
  served: Iterable<ServedBy | null | undefined>,
): Attribution[] {
  const seen = new Set<string>();
  const out: Attribution[] = [];
  for (const item of served) {
    if (!item) continue;
    const providers = new Set([item.provider, ...(item.contributingProviders ?? [])]);
    for (const provider of providers) {
      if (!provider) continue;
      const declared = registry.get(provider)?.dataSources ?? [];
      const reported = declared.filter((ds) => item.sourceIds?.includes(ds.sourceId));
      for (const ds of reported.length > 0 ? reported : declared) {
        if (seen.has(ds.sourceId)) continue;
        seen.add(ds.sourceId);
        out.push(dataSourceToAttribution(ds));
      }
    }
  }
  return out;
}
