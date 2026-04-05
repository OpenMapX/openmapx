import type { EnrichmentResult, EnrichmentSource, Place } from "@openmapx/core";
import { getIntegrationsByDomain } from "../../integration-host.js";

/**
 * Collect enrichment sources from all integrations registered under the "enrichment" domain.
 */
function getEnrichmentSources(): EnrichmentSource[] {
  const sources: EnrichmentSource[] = [];
  for (const integration of getIntegrationsByDomain("enrichment")) {
    for (const e of (integration.providers.get("enrichment") ?? []) as EnrichmentSource[]) {
      sources.push(e);
    }
  }
  return sources;
}

/**
 * Runs all enrichment sources in parallel and merges their results.
 * For scalar fields (description, wikipediaUrl) the first non-null value wins.
 * Photos and facts from all sources are concatenated.
 * Never throws — failures are silently dropped.
 */
export async function enrichPlace(place: Place, lang?: string): Promise<EnrichmentResult> {
  if (!place.osmTags) return {};

  const sources = getEnrichmentSources();

  const settled = await Promise.allSettled(
    sources.map((source) => source.enrich(place.osmTags as Record<string, string>, lang)),
  );

  const merged: EnrichmentResult = {};

  for (const result of settled) {
    if (result.status !== "fulfilled" || !result.value) continue;
    const { photos, description, wikipediaUrl, facts, externalIds } = result.value;

    if (description && !merged.description) merged.description = description;
    if (wikipediaUrl && !merged.wikipediaUrl) merged.wikipediaUrl = wikipediaUrl;
    if (photos?.length) merged.photos = [...(merged.photos ?? []), ...photos];
    if (facts?.length) merged.facts = [...(merged.facts ?? []), ...facts];
    // Merge external IDs — first value per key wins
    if (externalIds) {
      merged.externalIds = { ...externalIds, ...(merged.externalIds ?? {}) };
    }
  }

  return merged;
}
