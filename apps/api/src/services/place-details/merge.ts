import type { Place, PlaceIds } from "@openmapx/core";
import {
  buildFacebookUrl,
  buildFoursquareUrl,
  buildGoogleMapsUrl,
  buildInstagramUrl,
  buildTripadvisorUrl,
  buildYelpUrl,
} from "@openmapx/place-ids";

/**
 * Merge external identifiers (Wikidata-sourced Yelp / Tripadvisor / Google
 * Maps / Foursquare / Instagram / Facebook, the OSM `wikidata` tag, and safe
 * OSM Tripadvisor links) into `place.ids`. We only overlay — never overwrite —
 * so producer-level ids stay authoritative.
 */
export function foldExternalIdsIntoPlace(
  place: Place,
  externalIds: Record<string, string> | undefined,
): Place {
  const ids: PlaceIds = { ...place.ids };
  // Fall back to brand:wikidata (chain outlets often carry only that) so the
  // Wikidata reference still surfaces — e.g. a Shell station with brand:wikidata
  // but no place-level wikidata tag.
  const wd = place.osmTags?.wikidata ?? place.osmTags?.["brand:wikidata"];
  if (wd && !ids.wikidata) ids.wikidata = wd;
  if (externalIds) {
    if (externalIds.yelp && !ids.yelp && buildYelpUrl(externalIds.yelp)) {
      ids.yelp = externalIds.yelp;
    }
    if (
      externalIds.tripadvisor &&
      !ids.tripadvisor &&
      buildTripadvisorUrl(externalIds.tripadvisor)
    ) {
      ids.tripadvisor = externalIds.tripadvisor;
    }
    if (externalIds.google_maps && !ids.googleMaps && buildGoogleMapsUrl(externalIds.google_maps)) {
      ids.googleMaps = externalIds.google_maps;
    }
    if (externalIds.foursquare && !ids.foursquare && buildFoursquareUrl(externalIds.foursquare)) {
      ids.foursquare = externalIds.foursquare;
    }
    if (externalIds.instagram && !ids.instagram && buildInstagramUrl(externalIds.instagram)) {
      ids.instagram = externalIds.instagram;
    }
    if (externalIds.facebook && !ids.facebook && buildFacebookUrl(externalIds.facebook)) {
      ids.facebook = externalIds.facebook;
    }
    // Overture GERS id — surfaces as an "Overture Maps" external reference,
    // crediting the source whenever Overture enrichment matched the place.
    if (externalIds.gers && !ids.gers) {
      ids.gers = externalIds.gers;
    }
  }
  const osmTripadvisor = place.osmTags?.["contact:tripadvisor"];
  if (osmTripadvisor && !ids.tripadvisor && buildTripadvisorUrl(osmTripadvisor)) {
    ids.tripadvisor = osmTripadvisor;
  }
  return { ...place, ids };
}

/** Maps a social-profile URL to its OSM `contact:*` tag key, or null if unsupported. Exported for testing. */
export function socialContactTag(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
  if (host === "facebook.com" || host === "m.facebook.com" || host === "fb.com") {
    return "contact:facebook";
  }
  if (host === "instagram.com") return "contact:instagram";
  if (host === "twitter.com" || host === "x.com") return "contact:twitter";
  if (host === "youtube.com" || host === "youtu.be") return "contact:youtube";
  if (host === "linkedin.com") return "contact:linkedin";
  if (host === "t.me" || host === "telegram.me") return "contact:telegram";
  if (host === "pinterest.com") return "contact:pinterest";
  if (host === "reddit.com") return "contact:reddit";
  return null;
}

/**
 * Gap-fills OSM `contact:<platform>` tags from knowledge-source social URLs
 * (e.g. Overture `socials`) so they render in the place panel's social row.
 * OSM values are never overwritten.
 */
export function applyKnowledgeSocials(
  osmTags: Record<string, string> | undefined,
  socials: string[] | undefined,
): Record<string, string> | undefined {
  if (!socials?.length) return osmTags;
  const out = { ...(osmTags ?? {}) };
  for (const url of socials) {
    const tag = socialContactTag(url);
    if (tag && !out[tag]) out[tag] = url;
  }
  return out;
}

export function applyKnowledgeContactTags(
  osmTags: Record<string, string> | undefined,
  email: string | undefined,
  brand: Place["brand"],
): Record<string, string> | undefined {
  if (!email && !brand) return osmTags;
  const out = { ...(osmTags ?? {}) };
  if (email && !out.email && !out["contact:email"]) out.email = email;
  if (brand?.name && !out.brand) out.brand = brand.name;
  if (brand?.wikidata && !out["brand:wikidata"]) out["brand:wikidata"] = brand.wikidata;
  return out;
}

function websitePathDepth(url: string): number {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    return path === "" ? 0 : path.split("/").filter(Boolean).length;
  } catch {
    return 0;
  }
}

// Aggregator / directory hosts that should never win the website slot over an
// OSM-curated URL, even if their path looks more specific.
const WEBSITE_AGGREGATOR_HOSTS = new Set([
  "lieferando.de",
  "ubereats.com",
  "wolt.com",
  "booking.com",
  "opentable.com",
  "thefork.com",
  "facebook.com",
  "instagram.com",
  "google.com",
  "business.site",
  "linktr.ee",
  "yelp.com",
  "tripadvisor.com",
]);

/**
 * Picks the more specific of two website URLs by path depth — a deep outlet
 * link (e.g. find.shell.com/de/fuel/<store>) beats a bare brand homepage
 * (shell.de/). Returns whichever is present; ties keep the OSM URL; an
 * aggregator/directory host never displaces an OSM-curated URL. Exported for testing.
 */
export function pickMoreSpecificWebsite(
  osm: string | undefined,
  other: string | undefined,
): string | undefined {
  if (!other) return osm;
  if (!osm) return other;
  let otherHost: string;
  try {
    otherHost = new URL(other).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return osm;
  }
  if (WEBSITE_AGGREGATOR_HOSTS.has(otherHost)) return osm;
  return websitePathDepth(other) > websitePathDepth(osm) ? other : osm;
}

export function mergePlaceProvenance(
  first: Place["provenance"],
  second: Place["provenance"],
): Place["provenance"] {
  const combined = [...(first ?? []), ...(second ?? [])];
  if (combined.length === 0) return undefined;
  const seen = new Set<string>();
  return combined.filter((source) => {
    const key = `${source.sourceId}|${source.dataset}|${source.property ?? ""}|${source.recordId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
