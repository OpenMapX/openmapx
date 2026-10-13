import {
  type KnowledgeProvider,
  type KnowledgeResult,
  mergeKnowledgeResults,
  type Place,
} from "@openmapx/core";
import { getIntegrationsByDomain } from "../../integration-host.js";
import { getGatedIntegrationIds } from "../data-use-policy.js";

/**
 * Collect knowledge sources from all integrations registered under the "knowledge"
 * domain, skipping integrations the data-use policy disallows. Results merge into
 * one untagged object, so a gated source (e.g. marine weather, sunrise/sunset) has
 * to be dropped here — the per-item response filter can't reach it.
 */
function getKnowledgeSources(disallowedIntegrations: Set<string>): KnowledgeProvider[] {
  const sources: KnowledgeProvider[] = [];
  for (const integration of getIntegrationsByDomain("knowledge")) {
    if (disallowedIntegrations.has(integration.id)) continue;
    for (const e of (integration.providers.get("knowledge") ?? []) as KnowledgeProvider[]) {
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
export async function getPlaceKnowledge(
  place: Place,
  lang?: string,
  options?: {
    cardPhoto?: boolean;
    signal?: AbortSignal;
    onError?: (error: unknown) => void;
    onPhotos?: (photos: NonNullable<KnowledgeResult["photos"]>) => void;
  },
): Promise<KnowledgeResult> {
  if (!place.osmTags && !place.coordinates) return {};

  const sources = getKnowledgeSources(await getGatedIntegrationIds()).filter(
    (source) => !options?.cardPhoto || source.name === "wikidata" || source.name === "wikipedia",
  );

  const settled = await Promise.allSettled(
    sources.map((source) =>
      source
        .lookup((place.osmTags ?? {}) as Record<string, string>, lang, {
          coordinates: place.coordinates,
          name: place.name,
          ids: place.ids,
          cardPhoto: options?.cardPhoto,
          signal: options?.signal,
        })
        .then(
          (result) => {
            if (options?.cardPhoto && result?.photos?.length) options.onPhotos?.(result.photos);
            return result;
          },
          (error) => {
            options?.onError?.(error);
            throw error;
          },
        ),
    ),
  );

  return mergeKnowledgeResults(
    settled.flatMap((result) =>
      result.status === "fulfilled" && result.value ? [result.value] : [],
    ),
  );
}
