import type { Place, PlaceFact, PlacePhoto } from "../types/place";

export interface KnowledgeProvider {
  readonly id: string;
  lookup(place: Place): Promise<Partial<Place>>;
}

export interface KnowledgeResult {
  photos?: PlacePhoto[];
  description?: string;
  wikipediaExtract?: string;
  /** Integration ID(s) that supplied the Wikipedia extract. */
  wikipediaExtractSource?: string | string[];
  wikipediaUrl?: string;
  facts?: PlaceFact[];
  externalIds?: Record<string, string>;
}

export interface KnowledgeSource {
  readonly name: string;
  lookup(osmTags: Record<string, string>, lang?: string): Promise<KnowledgeResult | null>;
}
