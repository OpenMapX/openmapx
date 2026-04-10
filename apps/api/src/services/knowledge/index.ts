import type { KnowledgeResult, KnowledgeSource, Place } from "@openmapx/core";
import { getIntegrationsByDomain } from "../../integration-host.js";

/**
 * Collect knowledge sources from all integrations registered under the "knowledge" domain.
 */
function getKnowledgeSources(): KnowledgeSource[] {
  const sources: KnowledgeSource[] = [];
  for (const integration of getIntegrationsByDomain("knowledge")) {
    for (const e of (integration.providers.get("knowledge") ?? []) as KnowledgeSource[]) {
      sources.push(e);
    }
  }
  return sources;
}

/**
 * Runs all knowledge sources in parallel and merges their results.
 * For scalar fields (description, wikipediaUrl) the first non-null value wins.
 * Photos and facts from all sources are concatenated.
 * Never throws — failures are silently dropped.
 */
export async function getPlaceKnowledge(place: Place, lang?: string): Promise<KnowledgeResult> {
  if (!place.osmTags) return {};

  const sources = getKnowledgeSources();

  const settled = await Promise.allSettled(
    sources.map((source) => source.lookup(place.osmTags as Record<string, string>, lang)),
  );

  const merged: KnowledgeResult = {};

  for (const result of settled) {
    if (result.status !== "fulfilled" || !result.value) continue;
    const {
      photos,
      description,
      wikipediaExtract,
      wikipediaExtractSource,
      wikipediaUrl,
      facts,
      externalIds,
    } = result.value;

    if (description && !merged.description) merged.description = description;
    if (wikipediaExtract && !merged.wikipediaExtract) {
      merged.wikipediaExtract = wikipediaExtract;
      merged.wikipediaExtractSource = wikipediaExtractSource;
    }
    if (wikipediaUrl && !merged.wikipediaUrl) merged.wikipediaUrl = wikipediaUrl;
    if (photos?.length) merged.photos = [...(merged.photos ?? []), ...photos];
    if (facts?.length) merged.facts = [...(merged.facts ?? []), ...facts];
    if (externalIds) {
      merged.externalIds = { ...externalIds, ...(merged.externalIds ?? {}) };
    }
  }

  return merged;
}
