/**
 * Builds external review links for a place using three tiers:
 *   1. OSM extratags  — direct link when a platform ID is stored in OSM (e.g. ref:yelp)
 *   2. Wikidata IDs   — direct link from enriched external IDs (P2397 = Yelp, P7566 = Foursquare)
 *   3. Search URL     — fallback using place name + coordinates (always available)
 */

import type { Place, PlaceReviewLink } from "@openmapx/core";

interface PlatformDef {
  name: string;
  /** Keys in Place.osmTags to check (in priority order), e.g. ["ref:yelp", "contact:yelp"]. */
  osmTagKeys?: string[];
  /** Key in enriched externalIds map, e.g. "yelp" */
  wikidataKey?: string;
  /** Constructs a direct link from a known platform ID or URL. */
  directUrl?: (id: string) => string;
  /** Fallback search URL using place name + coordinates. */
  searchUrl: (name: string, lat: number, lng: number) => string;
}

const PLATFORMS: PlatformDef[] = [
  {
    name: "Google Maps",
    searchUrl: (name, lat, lng) =>
      `https://www.google.com/maps/search/${encodeURIComponent(name)}/@${lat},${lng},17z`,
  },
  {
    name: "Yelp",
    osmTagKeys: ["ref:yelp", "contact:yelp"],
    wikidataKey: "yelp",
    directUrl: (id) =>
      id.startsWith("http") ? id : `https://www.yelp.com/biz/${encodeURIComponent(id)}`,
    searchUrl: (name, lat, lng) =>
      `https://www.yelp.com/search?find_desc=${encodeURIComponent(name)}&find_lat=${lat}&find_lng=${lng}`,
  },
  {
    name: "TripAdvisor",
    osmTagKeys: ["contact:tripadvisor"],
    directUrl: (url) => (url.startsWith("http") ? url : `https://www.tripadvisor.com/${url}`),
    searchUrl: (name) => `https://www.tripadvisor.com/Search?q=${encodeURIComponent(name)}`,
  },
  {
    name: "Foursquare",
    osmTagKeys: ["ref:foursquare", "contact:foursquare"],
    wikidataKey: "foursquare",
    directUrl: (id) =>
      id.startsWith("http") ? id : `https://foursquare.com/v/${encodeURIComponent(id)}`,
    searchUrl: (name, lat, lng) =>
      `https://foursquare.com/explore?q=${encodeURIComponent(name)}&ll=${lat},${lng}`,
  },
];

/**
 * Returns a review link for each platform, resolving in priority order:
 * OSM extratag → Wikidata external ID → search URL fallback.
 */
export function buildReviewLinks(
  place: Place,
  externalIds: Record<string, string> = {},
): PlaceReviewLink[] {
  const [lng, lat] = place.coordinates;
  const osmTags = place.osmTags ?? {};

  return PLATFORMS.map((platform): PlaceReviewLink => {
    // Tier 1: OSM extratags (check all keys in priority order)
    if (platform.osmTagKeys && platform.directUrl) {
      for (const key of platform.osmTagKeys) {
        const val = osmTags[key];
        if (val) return { platform: platform.name, url: platform.directUrl(val) };
      }
    }

    // Tier 2: Wikidata external ID
    const wdId = platform.wikidataKey ? externalIds[platform.wikidataKey] : undefined;
    if (wdId && platform.directUrl) {
      return { platform: platform.name, url: platform.directUrl(wdId) };
    }

    // Tier 3: Search URL fallback
    return { platform: platform.name, url: platform.searchUrl(place.name, lat, lng) };
  });
}
