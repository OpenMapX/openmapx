import type { PlacePhoto } from "@openmapx/core";

export interface PhotoQuery {
  lat: number;
  lng: number;
  /** Place name — used by sources that support text search. */
  name?: string;
  /** Wikidata QID — used for Wikimedia entity-based lookups. */
  wikidataId?: string;
  /** Maximum number of photos to return from this provider. */
  limit?: number;
  /** OSM tags — when provided, tag-based lookups (e.g. wikimedia_commons) are included. */
  osmTags?: Record<string, string>;
}

/** A pluggable photo source. Return an empty array if no photos are found. */
export interface PhotoProvider {
  readonly id: string;
  readonly name: string;
  search(query: PhotoQuery): Promise<PlacePhoto[]>;
  /** Fast tag-based lookup (e.g. from OSM wikimedia_commons tag). Used for hero photos. */
  searchByTags?(osmTags: Record<string, string>, limit?: number): Promise<PlacePhoto[]>;
}
