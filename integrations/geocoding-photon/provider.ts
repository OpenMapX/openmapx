import type {
  GeocodingBias,
  GeocodingProvider as GeocodingProviderImpl,
} from "@openmapx/integration-geocoding/types";
/**
 * Photon geocoding client (by Komoot).
 * Backed by OSM data. No API key required.
 * Override with PHOTON_URL for a self-hosted instance.
 * https://photon.komoot.io
 */

import type {
  AutocompleteResult,
  LngLat,
  ReverseGeocodingResult,
  SearchResult,
} from "@openmapx/core";
import { fetchJson, normalizeSearchTerm, resolvePoiIconPath } from "@openmapx/core";

// Populated by setup(ctx); see setPhotonUrl.
let PHOTON_URL = "https://photon.komoot.io";

/** Update the Photon base URL (called from setup() when service registry resolves it). */
export function setPhotonUrl(url: string): void {
  PHOTON_URL = url;
}

/**
 * Manifest sourceId of the endpoint that answers, so a result credits Komoot
 * only when Komoot's public instance served it.
 */
export function photonSourceIds(): string[] {
  try {
    const host = new URL(PHOTON_URL).hostname.toLowerCase();
    if (host === "komoot.io" || host.endsWith(".komoot.io")) return ["komoot"];
  } catch {
    // An unparsable endpoint is not Komoot's.
  }
  return ["photon"];
}

// A search box needs both nearby places and famous far ones, and no single
// Photon bias returns both. Photon's location bias is a radius, set by a map
// zoom it takes as an integer, plus a weight for prominence against distance.
// With a tight radius at the default weight (0.2), "paris" from Berlin returned
// only Pariser Platz and "frankfurt" only Frankfurter Allee; with a wide radius
// and prominence weighted up, "fernsehturm" returned a dozen towers named
// exactly that and not the Berliner Fernsehturm next door. A biased lookup
// therefore asks both ways at once and merges them; the client ranks the
// mix for the actual zoom.
const LOCAL_BIAS = { maxZoom: 14, scale: 0.2, limit: 6 } as const;
const WIDE_BIAS = { maxZoom: 10, scale: 0.5, limit: 10 } as const;
const UNBIASED_LIMIT = "10";
/** Photon's language for each place's own name, as mapped locally. */
const NATIVE_LANG = "default";

function biasParams(
  bias: GeocodingBias,
  { maxZoom, scale, limit }: { maxZoom: number; scale: number; limit: number },
): Record<string, string> {
  return {
    lat: String(bias.proximity[1]),
    lon: String(bias.proximity[0]),
    zoom: String(Math.min(maxZoom, Math.max(0, Math.floor(bias.zoom ?? maxZoom)))),
    location_bias_scale: String(scale),
    limit: String(limit),
  };
}

interface PhotonProperties {
  osm_id: number;
  osm_type: string;
  osm_key: string;
  osm_value: string;
  name?: string;
  street?: string;
  housenumber?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: PhotonProperties;
}

interface PhotonResponse {
  features: PhotonFeature[];
}

function mapType(key: string): SearchResult["type"] {
  if (key === "highway") return "street";
  if (key === "addr" || key === "building") return "address";
  if (key === "boundary" || key === "place" || key === "natural" || key === "landuse")
    return "region";
  return "poi";
}

/**
 * Photon encodes the OSM element type as a single character (`N`, `W`,
 * `R`). Expand it to the canonical form so the id can round-trip through
 * the `osm:` place resolver.
 */
const OSM_TYPE_EXPANSIONS: Record<string, string> = { n: "node", w: "way", r: "relation" };

function makeId(p: PhotonProperties): string {
  const short = p.osm_type.toLowerCase();
  const full = OSM_TYPE_EXPANSIONS[short] ?? short;
  return `osm:${full}/${p.osm_id}`;
}

function buildLabel(p: PhotonProperties): string {
  const parts: string[] = [];
  if (p.name) parts.push(p.name);
  if (p.housenumber && p.street) parts.push(`${p.street} ${p.housenumber}`);
  else if (p.street) parts.push(p.street);
  if (p.city) parts.push(p.city);
  if (p.country) parts.push(p.country);
  return parts.join(", ") || "Unknown location";
}

async function fetchPhoton(
  params: Record<string, string>,
  path = "/api",
  lang?: string,
): Promise<PhotonResponse> {
  const url = new URL(`${PHOTON_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  return fetchJson<PhotonResponse>(url.toString(), {
    timeoutMs: 4_000,
    userAgent: null,
    headers: { "Accept-Language": lang ?? "en" },
    errorMessage: ({ status }) => `Photon error ${status}`,
  });
}

export const photonService: GeocodingProviderImpl = {
  async geocode(query: string, lang?: string, proximity?: LngLat): Promise<SearchResult[]> {
    const params: Record<string, string> = { q: query, limit: "10", lang: lang ?? "en" };
    if (proximity) {
      params.lat = String(proximity[1]);
      params.lon = String(proximity[0]);
    }
    const data = await fetchPhoton(params, "/api", lang);
    const sourceIds = photonSourceIds();
    return data.features.map((f) => ({
      id: makeId(f.properties),
      label: buildLabel(f.properties),
      coordinates: f.geometry.coordinates,
      type: mapType(f.properties.osm_key),
      confidence: 1,
      rawCategory: `${f.properties.osm_key}/${f.properties.osm_value}`,
      sourceIds,
    }));
  },

  async reverseGeocode(
    lat: number,
    lng: number,
    lang?: string,
  ): Promise<ReverseGeocodingResult | null> {
    const data = await fetchPhoton(
      { lat: String(lat), lon: String(lng), limit: "1" },
      "/reverse",
      lang,
    );
    const f = data.features[0];
    if (!f) return null;

    const p = f.properties;
    const city = [p.city, p.state].filter(Boolean).join(", ");
    return { address: buildLabel(p), city };
  },

  async autocomplete(
    query: string,
    lang?: string,
    bias?: GeocodingBias,
  ): Promise<AutocompleteResult[]> {
    const base = { q: query, lang: lang ?? "en" };
    let features: PhotonFeature[];
    if (bias) {
      const lookups = await Promise.allSettled([
        fetchPhoton({ ...base, ...biasParams(bias, LOCAL_BIAS) }, "/api", lang),
        fetchPhoton({ ...base, ...biasParams(bias, WIDE_BIAS) }, "/api", lang),
      ]);
      const answered = lookups.flatMap((lookup) =>
        lookup.status === "fulfilled" ? [lookup.value] : [],
      );
      // One lookup failing still leaves a useful answer; only both failing is an error.
      if (answered.length === 0 && lookups[0].status === "rejected") throw lookups[0].reason;
      const seen = new Set<string>();
      features = answered
        .flatMap((data) => data.features)
        .filter((f) => {
          const id = makeId(f.properties);
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });
    } else {
      features = (await fetchPhoton({ ...base, limit: UNBIASED_LIMIT }, "/api", lang)).features;
    }
    const nativeNames = await nativeNamesFor(features, query, {
      ...base,
      ...(bias ? biasParams(bias, WIDE_BIAS) : { limit: UNBIASED_LIMIT }),
    });
    const sourceIds = photonSourceIds();
    return features.map((f) => {
      const short = f.properties.name ?? buildLabel(f.properties);
      const full = buildLabel(f.properties);
      const native = nativeNames.get(makeId(f.properties));
      return {
        id: makeId(f.properties),
        label: short,
        sublabel: short !== full ? full : undefined,
        coordinates: f.geometry.coordinates,
        type: mapType(f.properties.osm_key),
        iconPath: resolvePoiIconPath(f.properties.osm_value),
        rawCategory: `${f.properties.osm_key}/${f.properties.osm_value}`,
        sourceIds,
        ...(native
          ? {
              searchMatch: { kind: "name", value: native, normalized: normalizeSearchTerm(native) },
            }
          : {}),
      } satisfies AutocompleteResult;
    });
  },
};

/** Whether every word typed starts a word of `name`, ignoring case and accents. */
function nameStartsWith(name: string | undefined, query: string): boolean {
  const nameWords = normalizeSearchTerm(name ?? "").split(" ");
  return normalizeSearchTerm(query)
    .split(" ")
    .every((token) => nameWords.some((word) => word.startsWith(token)));
}

/**
 * Photon matches every name a place has but answers in the language asked
 * for: "köln" finds the city labelled "Cologne", "münchen" the one labelled
 * "Munich", and nothing in the answer says why. When some answer does not
 * carry the words typed, ask once more for places' own names and keep, by
 * place, the native name that does: the match the ranking can see.
 */
async function nativeNamesFor(
  features: readonly PhotonFeature[],
  query: string,
  params: Record<string, string>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (params.lang === NATIVE_LANG) return names;
  if (features.every((f) => nameStartsWith(f.properties.name, query))) return names;
  try {
    const native = await fetchPhoton({ ...params, lang: NATIVE_LANG }, "/api", NATIVE_LANG);
    for (const f of native.features) {
      if (f.properties.name && nameStartsWith(f.properties.name, query)) {
        names.set(makeId(f.properties), f.properties.name);
      }
    }
  } catch {
    // The labels still stand; only the evidence of an exonym match is lost.
  }
  return names;
}
