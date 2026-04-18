/**
 * Builds external review links for a place using three tiers:
 *   1. OSM extratags  — direct link when a platform ID is stored in OSM (e.g. ref:yelp)
 *   2. place.ids      — direct link from Wikidata-sourced external identifiers
 *                       (P3108 = Yelp, P3134 = TripAdvisor, P3749 = Google Maps,
 *                        P2464 = Foursquare, P2003 = Instagram, P2013 = Facebook).
 *   3. Search URL     — fallback using place name + coordinates. Direct-only
 *                       platforms (Instagram, Facebook) omit this tier because
 *                       their site search is too flaky to be useful as a fallback.
 *
 * The direct-URL logic in tiers 1 and 2 is shared with the place panel's
 * external-id links via the core id-scheme registry (`getIdSchemeView`),
 * so there's a single owner for e.g. "given a Yelp id, build the link".
 */

import { getIdSchemeView, type Place, type PlaceReviewLink } from "@openmapx/core";

interface PlatformDef {
  name: string;
  /** Id-scheme key in `place.ids` (e.g. "yelp"). Also drives the direct URL via the scheme registry. */
  scheme: string;
  /** Keys in Place.osmTags to check (in priority order), e.g. ["ref:yelp", "contact:yelp"]. */
  osmTagKeys?: string[];
  /**
   * Fallback search URL using place name + coordinates. Omit for platforms
   * where the search UI is too flaky to be useful (Instagram tags, Facebook
   * site search) — such platforms are treated as "direct-only" and only
   * appear when we actually have a known id.
   */
  searchUrl?: (name: string, lat: number, lng: number) => string;
}

const PLATFORMS: PlatformDef[] = [
  {
    name: "Google Maps",
    scheme: "googleMaps",
    searchUrl: (name, lat, lng) =>
      `https://www.google.com/maps/search/${encodeURIComponent(name)}/@${lat},${lng},17z`,
  },
  {
    name: "Yelp",
    scheme: "yelp",
    osmTagKeys: ["ref:yelp", "contact:yelp"],
    searchUrl: (name, lat, lng) =>
      `https://www.yelp.com/search?find_desc=${encodeURIComponent(name)}&find_loc=${lat},${lng}`,
  },
  {
    name: "TripAdvisor",
    scheme: "tripadvisor",
    osmTagKeys: ["contact:tripadvisor"],
    searchUrl: (name) => `https://www.tripadvisor.com/Search?q=${encodeURIComponent(name)}`,
  },
  // Direct-only: Foursquare retired its consumer city-guide search.
  {
    name: "Foursquare",
    scheme: "foursquare",
    osmTagKeys: ["ref:foursquare", "contact:foursquare"],
  },
  // Direct-only: Instagram tag/location search is too noisy to be a fallback.
  { name: "Instagram", scheme: "instagram", osmTagKeys: ["contact:instagram"] },
  // Direct-only: Facebook site search requires a logged-in session.
  { name: "Facebook", scheme: "facebook", osmTagKeys: ["contact:facebook"] },
];

/**
 * Build the direct URL for a platform/value pair, delegating to the
 * registered id-scheme view. Returns `undefined` when no view is
 * registered or the view can't build a URL for this value.
 */
function directUrlFor(scheme: string, value: string): string | undefined {
  return getIdSchemeView(scheme)?.buildUrl?.(value);
}

/**
 * Returns a review link for each platform, resolving in priority order:
 * OSM extratag → place.ids external ID → search URL fallback.
 */
export function buildReviewLinks(place: Place): PlaceReviewLink[] {
  const [lng, lat] = place.coordinates;
  const osmTags = place.osmTags ?? {};
  const ids = place.ids ?? {};

  const out: PlaceReviewLink[] = [];
  for (const platform of PLATFORMS) {
    let matched: string | undefined;

    // Tier 1: OSM extratags (check all keys in priority order)
    if (platform.osmTagKeys) {
      for (const key of platform.osmTagKeys) {
        const val = osmTags[key];
        if (val) {
          matched = directUrlFor(platform.scheme, val);
          if (matched) break;
        }
      }
    }

    // Tier 2: place.ids external identifier
    if (!matched) {
      const idsVal = ids[platform.scheme];
      if (idsVal) matched = directUrlFor(platform.scheme, idsVal);
    }

    if (matched) {
      out.push({ platform: platform.name, url: matched });
      continue;
    }

    // Tier 3: Search URL fallback — only if the platform provides one.
    // Direct-only platforms are omitted entirely when we have no known id.
    if (platform.searchUrl) {
      out.push({ platform: platform.name, url: platform.searchUrl(place.name, lat, lng) });
    }
  }
  return out;
}
