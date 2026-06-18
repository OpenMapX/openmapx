/**
 * Builds external review links for a place using three tiers:
 *   1. OSM extratags  — direct link when a platform ID is stored in OSM (e.g. ref:yelp)
 *   2. place.ids      — direct link from Wikidata-sourced external identifiers
 *                       (P3108 = Yelp, P3134 = Tripadvisor, P3749 = Google Maps,
 *                        P2464 = Foursquare, P2003 = Instagram, P2013 = Facebook).
 *   3. Search URL     — fallback using place context. Direct-only platforms
 *                       (Instagram, Facebook) omit this tier because their
 *                       site search is too flaky to be useful as a fallback.
 *
 * The direct-URL logic in tiers 1 and 2 is shared with the place panel's
 * external-id links via the core id-scheme registry (`getIdSchemeView`),
 * so there's a single owner for e.g. "given a Yelp id, build the link".
 */

import type { Place, PlaceReviewLink } from "@openmapx/core";
import { getIdSchemeView } from "@openmapx/place-ids";
import { shouldBuildReviewFallbackSearch } from "./review-link-fallback-policy";

type ReviewLinkSource = NonNullable<PlaceReviewLink["source"]>;

interface PlatformDef {
  name: string;
  /** Id-scheme key in `place.ids` (e.g. "yelp"). Also drives the direct URL via the scheme registry. */
  scheme: string;
  /** Keys in Place.osmTags to check (in priority order), e.g. ["ref:yelp", "contact:yelp"]. */
  osmTagKeys?: string[];
  /**
   * Fallback search URL. Omit for platforms where the search UI is too flaky
   * to be useful (Instagram tags, Facebook site search) — such platforms are
   * treated as "direct-only" and only appear when we actually have a known id.
   */
  searchUrl?: (place: Place) => string | undefined;
}

const PLATFORMS: PlatformDef[] = [
  {
    name: "Google Maps",
    scheme: "googleMaps",
    searchUrl: (place) => {
      const [lng, lat] = place.coordinates;
      return `https://www.google.com/maps/search/${encodeURIComponent(place.name)}/@${lat},${lng},17z`;
    },
  },
  {
    name: "Yelp",
    scheme: "yelp",
    osmTagKeys: ["ref:yelp", "contact:yelp"],
    searchUrl: (place) => {
      const [lng, lat] = place.coordinates;
      return `https://www.yelp.com/search?find_desc=${encodeURIComponent(place.name)}&find_loc=${lat},${lng}`;
    },
  },
  {
    name: "Tripadvisor",
    scheme: "tripadvisor",
    osmTagKeys: ["contact:tripadvisor"],
    searchUrl: (place) =>
      `https://www.tripadvisor.com/Search?q=${encodeURIComponent(searchQueryForPlace(place))}`,
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

function directLinkFor(
  platform: PlatformDef,
  value: string,
  source: ReviewLinkSource,
): PlaceReviewLink | undefined {
  const url = directUrlFor(platform.scheme, value);
  if (!url) return undefined;
  return { platform: platform.name, url, kind: "direct", source, confidence: "high" };
}

function cleanSearchPart(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

function searchQueryForPlace(place: Place): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const part of [
    place.name,
    place.city,
    place.countryCode?.toUpperCase(),
    place.city ? undefined : place.address,
  ]) {
    const cleaned = cleanSearchPart(part);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(cleaned);
  }
  return parts.join(" ");
}

/**
 * Returns a review link for each platform, resolving in priority order:
 * OSM extratag → place.ids external ID → search URL fallback.
 */
export function buildReviewLinks(place: Place): PlaceReviewLink[] {
  const osmTags = place.osmTags ?? {};
  const ids = place.ids ?? {};

  const out: PlaceReviewLink[] = [];
  for (const platform of PLATFORMS) {
    let matched: PlaceReviewLink | undefined;

    // First: OSM extratags (check all keys in priority order)
    if (platform.osmTagKeys) {
      for (const key of platform.osmTagKeys) {
        const val = osmTags[key];
        if (val) {
          matched = directLinkFor(platform, val, "osm");
          if (matched) break;
        }
      }
    }

    // Next: place.ids external identifier
    if (!matched) {
      const idsVal = ids[platform.scheme];
      if (idsVal) matched = directLinkFor(platform, idsVal, "wikidata");
    }

    if (matched) {
      out.push(matched);
      continue;
    }

    // Last: Search URL fallback — only if the platform provides one.
    // Direct-only platforms are omitted entirely when we have no known id.
    if (platform.searchUrl && shouldBuildReviewFallbackSearch(platform.scheme, place)) {
      const searchUrl = platform.searchUrl(place);
      if (searchUrl) {
        out.push({
          platform: platform.name,
          url: searchUrl,
          kind: "search",
          source: "fallback",
          confidence: "low",
        });
      }
    }
  }
  return out;
}
