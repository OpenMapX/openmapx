import type { BoundingBox, OverpassFilter, Place, PoiSearchReturn } from "@openmapx/core";

export type { PoiSearchOutcome, PoiSearchResult, PoiSearchReturn } from "@openmapx/core";

/**
 * A POI source the orchestrator can query within a bbox.
 *
 * Every search method may return either a plain array or a `PoiSearchOutcome`.
 * The outcome form lets a provider declare that its own result ceiling cut the
 * set, which is what stops the orchestrator from presenting a truncated answer
 * as complete; the array form stays valid so existing providers need no change.
 */
export interface PoiSearchProvider {
  readonly id: string;
  readonly categories: string[];
  search(
    category: string,
    bbox: BoundingBox,
    options?: {
      lang?: string;
      filters?: Record<string, unknown>;
      /** Pre-derived OSM tag-set (AND semantics; `"*"` means key existence). When
       *  present, the provider should query for features matching all of these
       *  tags together instead of looking up `category` in its internal
       *  `CATEGORY_FILTERS` map. Set by the orchestrator on `preset:`-prefixed
       *  category requests. */
      osmTags?: Record<string, string>;
    },
  ): Promise<PoiSearchReturn>;
  /** Free-text name search within a bbox. Optional — only providers backed by a
   *  general-purpose source (e.g. Overpass) implement it. */
  searchText?(
    query: string,
    bbox: BoundingBox,
    options?: { lang?: string },
  ): Promise<PoiSearchReturn>;
  /** Category search with additional OSM attribute filters (AND semantics).
   *  Optional — providers that support attribute-level filtering implement it. */
  searchFiltered?(
    category: string,
    attributes: Record<string, string>,
    bbox: BoundingBox,
    options?: { lang?: string },
  ): Promise<PoiSearchReturn>;
  /** Structured open tag-filter search (OR'd selectors + require/exclude). Optional —
   *  providers backed by a general-purpose source (e.g. Overpass) implement it. */
  searchByFilter?(
    filter: OverpassFilter,
    bbox: BoundingBox,
    options?: { lang?: string },
  ): Promise<PoiSearchReturn>;
  getDetail?(poiId: string): Promise<Place | null>;
}
