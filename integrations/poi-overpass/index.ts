import type { BoundingBox } from "@openmapx/core";
import {
  CATEGORY_FILTERS,
  searchByCategory,
  searchByCategoryWithAttributes,
  searchByFilter,
  searchByOsmTags,
  searchByText,
  setOverpassUrl,
} from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import type { PoiSearchProvider, PoiSearchResult } from "@openmapx/integration-poi-search/types";

const PRESET_SENTINEL = "__preset__";

export const overpassProvider: PoiSearchProvider = {
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
  async searchFiltered(
    category: string,
    attributes: Record<string, string>,
    bbox: BoundingBox,
  ): Promise<PoiSearchResult[]> {
    const filters = CATEGORY_FILTERS[category];
    if (!filters) {
      throw Object.assign(new Error(`Unknown category: ${category}`), { statusCode: 400 });
    }
    return searchByCategoryWithAttributes(filters, attributes, bbox);
  },
  // Overpass tag queries are language-agnostic (results come straight from OSM
  // tags), so the orchestrator's optional `lang` is intentionally not forwarded
  // here — matching searchByCategoryWithAttributes above.
  async searchByFilter(filter, bbox) {
    return searchByFilter(filter, bbox);
  },
};

export function setup(ctx: IntegrationContext): void {
  const resolved = ctx.getRequiredService("overpass");
  if (resolved?.url) setOverpassUrl(resolved.url);
  ctx.registerPoiSearchProvider(overpassProvider);
}
