import type { KnowledgeProvider, KnowledgeResult, Place } from "@openmapx/core";
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
export async function getPlaceKnowledge(place: Place, lang?: string): Promise<KnowledgeResult> {
  if (!place.osmTags && !place.coordinates) return {};

  const sources = getKnowledgeSources(await getGatedIntegrationIds());

  const settled = await Promise.allSettled(
    sources.map((source) =>
      source.lookup((place.osmTags ?? {}) as Record<string, string>, lang, {
        coordinates: place.coordinates,
        name: place.name,
        ids: place.ids,
      }),
    ),
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
      airport,
      brand,
      names,
      phone,
      email,
      website,
      socials,
      address,
      city,
      countryCode,
      provenance,
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
    if (airport && !merged.airport) merged.airport = airport;
    if (brand && !merged.brand) merged.brand = brand;
    if (names && !merged.names) merged.names = names;
    if (phone && !merged.phone) merged.phone = phone;
    if (email && !merged.email) merged.email = email;
    if (website && !merged.website) merged.website = website;
    if (socials?.length && !merged.socials) merged.socials = socials;
    if (address && !merged.address) merged.address = address;
    if (city && !merged.city) merged.city = city;
    if (countryCode && !merged.countryCode) merged.countryCode = countryCode;
    if (provenance?.length) {
      const known = new Set(
        (merged.provenance ?? []).map(
          (source) =>
            `${source.sourceId}|${source.dataset}|${source.property ?? ""}|${source.recordId ?? ""}`,
        ),
      );
      merged.provenance = [...(merged.provenance ?? [])];
      for (const source of provenance) {
        const key = `${source.sourceId}|${source.dataset}|${source.property ?? ""}|${source.recordId ?? ""}`;
        if (!known.has(key)) {
          known.add(key);
          merged.provenance.push(source);
        }
      }
    }
  }

  return merged;
}
