import type { PlaceFact, PlacePhoto } from "@openmapx/core";

export interface EnrichmentResult {
  photos?: PlacePhoto[];
  description?: string;
  wikipediaUrl?: string;
  facts?: PlaceFact[];
  /** External platform IDs keyed by platform slug (e.g. "yelp", "foursquare"). */
  externalIds?: Record<string, string>;
}

/** A single pluggable data source. Return null if the source has no data for this place. */
export interface EnrichmentSource {
  readonly name: string;
  enrich(osmTags: Record<string, string>): Promise<EnrichmentResult | null>;
}
