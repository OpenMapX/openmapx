import type { LngLat } from "../types/geometry";
import type { AirportInfo, PlaceFact, PlacePhoto } from "../types/place";

export interface KnowledgeResult {
  photos?: PlacePhoto[];
  description?: string;
  wikipediaExtract?: string;
  /** Integration ID(s) that supplied the Wikipedia extract. */
  wikipediaExtractSource?: string | string[];
  wikipediaUrl?: string;
  facts?: PlaceFact[];
  externalIds?: Record<string, string>;
  /** OurAirports-derived structured airport detail (runways, frequencies, navaids). */
  airport?: AirportInfo;
}

/**
 * Optional non-tag context passed to `KnowledgeProvider.lookup`. Used by sources
 * that need spatial fallbacks (e.g. matching an airport terminal building to
 * its parent aerodrome when the terminal doesn't carry IATA/ICAO tags itself).
 */
export interface KnowledgeContext {
  coordinates?: LngLat;
  name?: string;
}

export interface KnowledgeProvider {
  readonly name: string;
  lookup(
    osmTags: Record<string, string>,
    lang?: string,
    context?: KnowledgeContext,
  ): Promise<KnowledgeResult | null>;
}
