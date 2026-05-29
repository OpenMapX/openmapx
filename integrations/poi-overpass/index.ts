import type { BoundingBox } from "@openmapx/core";
import {
  CATEGORY_FILTERS,
  searchByCategory,
  searchByOsmTags,
  searchByText,
  setOverpassUrl,
} from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import type { PoiSearchProvider, PoiSearchResult } from "@openmapx/integration-poi-search/types";

const PRESET_SENTINEL = "__preset__";

const overpassProvider: PoiSearchProvider = {
  id: "overpass",
  categories: [...Object.keys(CATEGORY_FILTERS), PRESET_SENTINEL],
  async search(
    category: string,
    bbox: BoundingBox,
    options?: {
      lang?: string;
      filters?: Record<string, unknown>;
      osmTags?: Record<string, string>;
    },
  ): Promise<PoiSearchResult[]> {
    if (options?.osmTags) {
      // Preset path: tag-set must be ANDed; wildcards (`"*"`) become key-existence
      // predicates. Bypasses CATEGORY_FILTERS entirely.
      return searchByOsmTags(options.osmTags, bbox);
    }
    const filters = CATEGORY_FILTERS[category];
    if (!filters || filters.length === 0) return [];
    return searchByCategory(filters, bbox);
  },
  async searchText(query: string, bbox: BoundingBox): Promise<PoiSearchResult[]> {
    return searchByText(query, bbox);
  },
};

export function setup(ctx: IntegrationContext): void {
  const resolved = ctx.getRequiredService("overpass");
  if (resolved?.url) setOverpassUrl(resolved.url);
  ctx.registerPoiSearchProvider(overpassProvider);
}
