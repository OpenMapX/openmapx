import type { BoundingBox } from "@openmapx/core";
import {
  CATEGORY_FILTERS,
  searchByCategory,
  searchByCategoryWithAttributes,
  searchByFilter,
  searchByOsmTags,
  searchByText,
  setOverpassContributorResolver,
  setOverpassUrl,
} from "@openmapx/core";
import {
  type IntegrationContext,
  resolveIntegrationContributors,
} from "@openmapx/integration-framework";
import type { PoiSearchOutcome, PoiSearchProvider } from "@openmapx/integration-poi-search/types";
import { OPENSTREETMAP_ATTRIBUTION } from "@openmapx/mobility-core/attribution";

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
  ): Promise<PoiSearchOutcome> {
    if (options?.osmTags) {
      // Preset path: tag-set must be ANDed; wildcards (`"*"`) become key-existence
      // predicates. Bypasses CATEGORY_FILTERS entirely.
      return searchByOsmTags(options.osmTags, bbox);
    }
    const filters = CATEGORY_FILTERS[category];
    if (!filters || filters.length === 0) return { results: [], truncated: false };
    return searchByCategory(filters, bbox);
  },
  async searchText(query: string, bbox: BoundingBox): Promise<PoiSearchOutcome> {
    return searchByText(query, bbox);
  },
  async searchFiltered(
    category: string,
    attributes: Record<string, string>,
    bbox: BoundingBox,
  ): Promise<PoiSearchOutcome> {
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
  ctx.onActivate(() => {
    if (resolved?.url) setOverpassUrl(resolved.url);
    setOverpassContributorResolver((url) => {
      const host = new URL(url).hostname;
      const sourceId =
        host === "overpass-api.de"
          ? "overpass"
          : host === "overpass.kumi.systems"
            ? "overpass-kumi"
            : undefined;
      return sourceId
        ? resolveIntegrationContributors(ctx, [sourceId])
        : [OPENSTREETMAP_ATTRIBUTION];
    });
  });
  ctx.registerPoiSearchProvider(overpassProvider);
}
