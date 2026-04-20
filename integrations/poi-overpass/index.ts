import type { BoundingBox, IntegrationContext } from "@openmapx/core";
import { CATEGORY_FILTERS, searchByCategory, setOverpassUrl } from "@openmapx/core";
import type { PoiSearchProvider, PoiSearchResult } from "../poi-search/types.js";

const overpassProvider: PoiSearchProvider = {
  id: "overpass",
  categories: Object.keys(CATEGORY_FILTERS),

  async search(category: string, bbox: BoundingBox): Promise<PoiSearchResult[]> {
    const filters = CATEGORY_FILTERS[category];
    if (!filters) return [];
    return searchByCategory(filters, bbox);
  },
};

export function setup(ctx: IntegrationContext): void {
  const resolved = ctx.getRequiredService("overpass");
  if (resolved?.url) setOverpassUrl(resolved.url);
  ctx.registerProvider("poi-search", overpassProvider);
}
