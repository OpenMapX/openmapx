import type { PlaceFact, PlacePhoto } from "@openmapx/core";

export interface EnrichmentResult {
  photos?: PlacePhoto[];
  /** Short tagline (from Wikidata entity description). */
  description?: string;
  /** Longer article summary (from Wikipedia extract). */
  wikipediaExtract?: string;
  /** Integration ID(s) that supplied the Wikipedia extract. */
  wikipediaExtractSource?: string | string[];
  wikipediaUrl?: string;
  facts?: PlaceFact[];
  /** External platform IDs keyed by platform slug (e.g. "yelp", "tripadvisor"). */
  externalIds?: Record<string, string>;
}

/** A single pluggable data source. Return null if the source has no data for this place. */
export interface EnrichmentSource {
  readonly name: string;
  enrich(osmTags: Record<string, string>, lang?: string): Promise<EnrichmentResult | null>;
}
