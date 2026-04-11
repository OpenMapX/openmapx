import type { BoundingBox, IntegrationContext } from "@openmapx/core";
import { OverpassTimeoutError } from "@openmapx/core";
import type { PoiSearchProvider, PoiSearchResult } from "./types.js";

const MAX_SHRINK_RETRIES = 3;
const SHRINK_FACTOR = 0.6;

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
    category: string,
    bbox: BoundingBox,
    options?: { lang?: string },
  ): Promise<{ results: PoiSearchResult[]; partial: boolean }> {
    const providers = getProviders();
    const provider = providers.find((p) => p.categories.includes(category));
    if (!provider) {
      throw Object.assign(new Error(`Unknown category: ${category}`), { statusCode: 400 });
    }

    let currentBbox = bbox;
    for (let attempt = 0; ; attempt++) {
      try {
        const results = await provider.search(category, currentBbox, {
          lang: options?.lang,
        });
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

  return { search, getProviders };
}
