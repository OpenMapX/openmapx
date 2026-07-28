import type { LngLat } from "../types/geometry";
import type { Ids } from "../types/identified";
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
  /** Brand identity (name + optional Wikidata Q-id). */
  brand?: { name: string; wikidata?: string };
  /** Multilingual name variants keyed by BCP-47 language tag. */
  names?: Record<string, string>;
  /** Contact phone supplied by a source — fills a gap when the base place lacks one. */
  phone?: string;
  /** Contact email supplied by a source — fills a gap when the base place lacks one. */
  email?: string;
  /** Contact website/homepage supplied by a source — fills a gap when the base place lacks one. */
  website?: string;
  /** Social-profile URLs (e.g. Facebook/Instagram) supplied by a source. */
  socials?: string[];
  /** Formatted street address supplied by a source. */
  address?: string;
  city?: string;
  countryCode?: string;
}

/**
 * Optional non-tag context passed to `KnowledgeProvider.lookup`. Used by sources
 * that need spatial fallbacks (e.g. matching an airport terminal building to
 * its parent aerodrome when the terminal doesn't carry IATA/ICAO tags itself).
 */
export interface KnowledgeContext {
  coordinates?: LngLat;
  name?: string;
  /** All known external identifiers for the place (used for link-first GERS lookup). */
  ids?: Ids;
}

export interface KnowledgeProvider {
  readonly name: string;
  lookup(
    osmTags: Record<string, string>,
    lang?: string,
    context?: KnowledgeContext,
  ): Promise<KnowledgeResult | null>;
}
