import type { Place, PlaceFact, PlacePhoto } from "../types/place";

export interface EnrichmentProvider {
  readonly id: string;
  enrich(place: Place): Promise<Partial<Place>>;
}

export interface EnrichmentResult {
  photos?: PlacePhoto[];
  description?: string;
  wikipediaExtract?: string;
  /** Integration ID(s) that supplied the Wikipedia extract. */
  wikipediaExtractSource?: string | string[];
  wikipediaUrl?: string;
  facts?: PlaceFact[];
  externalIds?: Record<string, string>;
}

export interface EnrichmentSource {
  readonly name: string;
  enrich(osmTags: Record<string, string>, lang?: string): Promise<EnrichmentResult | null>;
}
