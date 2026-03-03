import type { Place } from "@openmapx/core";
import type { EnrichmentResult, EnrichmentSource } from "./types";
import { wikidataEnricher } from "./wikidata.enricher";
import { wikimediaCommonsEnricher } from "./wikimedia-commons.enricher";
import { wikipediaEnricher } from "./wikipedia.enricher";

const SOURCES: EnrichmentSource[] = [wikidataEnricher, wikipediaEnricher, wikimediaCommonsEnricher];

/**
 * Runs all enrichment sources in parallel and merges their results.
 * For scalar fields (description, wikipediaUrl) the first non-null value wins.
 * Photos and facts from all sources are concatenated.
 * Never throws — failures are silently dropped.
 */
export async function enrichPlace(place: Place): Promise<EnrichmentResult> {
  if (!place.osmTags) return {};

  const settled = await Promise.allSettled(
    SOURCES.map((source) => source.enrich(place.osmTags as Record<string, string>)),
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
