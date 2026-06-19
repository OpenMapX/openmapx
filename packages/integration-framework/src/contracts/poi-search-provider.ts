import type { BoundingBox, LngLat, OpeningHoursInfo, OverpassFilter, Place } from "@openmapx/core";

export interface PoiSearchResult {
  id: string;
  name: string;
  coordinates: LngLat;
  category?: string;
  address?: string;
  phone?: string;
  website?: string;
  openingHours?: string;
  isOpen?: boolean;
  osmTags?: Record<string, string>;
  /** Set by the orchestrator after the provider returns results. */
  openingHoursInfo?: OpeningHoursInfo;
}

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
  ): Promise<PoiSearchResult[]>;
  /** Free-text name search within a bbox. Optional — only providers backed by a
   *  general-purpose source (e.g. Overpass) implement it. */
  searchText?(
    query: string,
    bbox: BoundingBox,
    options?: { lang?: string },
  ): Promise<PoiSearchResult[]>;
  /** Category search with additional OSM attribute filters (AND semantics).
   *  Optional — providers that support attribute-level filtering implement it. */
  searchFiltered?(
    category: string,
    attributes: Record<string, string>,
    bbox: BoundingBox,
    options?: { lang?: string },
  ): Promise<PoiSearchResult[]>;
  /** Structured open tag-filter search (OR'd selectors + require/exclude). Optional —
   *  providers backed by a general-purpose source (e.g. Overpass) implement it. */
  searchByFilter?(
    filter: OverpassFilter,
    bbox: BoundingBox,
    options?: { lang?: string },
  ): Promise<PoiSearchResult[]>;
  getDetail?(poiId: string): Promise<Place | null>;
}
