import type { BoundingBox } from "@openmapx/core";
import { OverpassTimeoutError } from "@openmapx/core";
import { buildOpeningHoursInfo } from "@openmapx/core/server";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { getPresetById } from "@openmapx/presets";
import type { PoiSearchProvider, PoiSearchResult } from "./types.js";

const MAX_SHRINK_RETRIES = 3;
const SHRINK_FACTOR = 0.6;
const PRESET_PREFIX = "preset:";
const PRESET_SENTINEL = "__preset__";

function shrinkBbox(bbox: BoundingBox, factor: number): BoundingBox {
  const centerLat = (bbox.north + bbox.south) / 2;
  const centerLon = (bbox.east + bbox.west) / 2;
  const halfLat = ((bbox.north - bbox.south) / 2) * factor;
  const halfLon = ((bbox.east - bbox.west) / 2) * factor;
  return {
    south: centerLat - halfLat,
    north: centerLat + halfLat,
    west: centerLon - halfLon,
    east: centerLon + halfLon,
  };
}

export function createPoiSearchOrchestrator(ctx: IntegrationContext) {
  function getProviders(): PoiSearchProvider[] {
    const integrations = ctx.getIntegrationsByDomain("poi-search");
    const providers: PoiSearchProvider[] = [];
    for (const integration of integrations) {
      const registered = (integration.providers.get("poi-search") ?? []) as PoiSearchProvider[];
      providers.push(...registered);
    }
    return providers;
  }

  async function search(
    category: unknown,
    bbox: BoundingBox,
    options?: { lang?: string },
  ): Promise<{ results: PoiSearchResult[]; partial: boolean }> {
    if (typeof category !== "string" || category.length === 0) {
      throw Object.assign(new Error("Missing or invalid category"), { statusCode: 400 });
    }

    const providers = getProviders();

    let osmTags: Record<string, string> | undefined;
    let lookupCategory = category;

    if (category.startsWith(PRESET_PREFIX)) {
      const presetId = category.slice(PRESET_PREFIX.length);
      const preset = getPresetById(presetId);
      if (!preset) {
        throw Object.assign(new Error(`Unknown preset: ${presetId}`), { statusCode: 400 });
      }
      osmTags = preset.tags;
      lookupCategory = PRESET_SENTINEL;
    }

    const provider = providers.find((p) => p.categories.includes(lookupCategory));
    if (!provider) {
      throw Object.assign(new Error(`Unknown category: ${category}`), { statusCode: 400 });
    }

    let currentBbox = bbox;
    for (let attempt = 0; ; attempt++) {
      try {
        const results = await provider.search(lookupCategory, currentBbox, {
          lang: options?.lang,
          osmTags,
        });
        for (const r of results) {
          if (r.openingHours && !r.openingHoursInfo) {
            r.openingHoursInfo = buildOpeningHoursInfo(r.openingHours, {
              lat: r.coordinates[1],
              lon: r.coordinates[0],
            });
          }
        }
        return { results, partial: attempt > 0 };
      } catch (err) {
        if (err instanceof OverpassTimeoutError && attempt < MAX_SHRINK_RETRIES) {
          currentBbox = shrinkBbox(currentBbox, SHRINK_FACTOR);
          continue;
        }
        throw err;
      }
    }
  }

  async function searchText(
    query: unknown,
    bbox: BoundingBox,
    options?: { lang?: string },
  ): Promise<{ results: PoiSearchResult[]; partial: boolean }> {
    if (typeof query !== "string" || query.trim().length === 0) {
      throw Object.assign(new Error("Missing or empty query"), { statusCode: 400 });
    }
    const provider = getProviders().find((p) => typeof p.searchText === "function");
    if (!provider?.searchText) {
      throw Object.assign(new Error("No text-search provider available"), { statusCode: 400 });
    }

    let currentBbox = bbox;
    for (let attempt = 0; ; attempt++) {
      try {
        const results = await provider.searchText(query, currentBbox, { lang: options?.lang });
        for (const r of results) {
          if (r.openingHours && !r.openingHoursInfo) {
            r.openingHoursInfo = buildOpeningHoursInfo(r.openingHours, {
              lat: r.coordinates[1],
              lon: r.coordinates[0],
            });
          }
        }
        return { results, partial: attempt > 0 };
      } catch (err) {
        if (err instanceof OverpassTimeoutError && attempt < MAX_SHRINK_RETRIES) {
          currentBbox = shrinkBbox(currentBbox, SHRINK_FACTOR);
          continue;
        }
        throw err;
      }
    }
  }

  return { search, searchText, getProviders };
}
