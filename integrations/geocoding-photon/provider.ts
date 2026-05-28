import type { GeocodingProviderImpl } from "./types.js";
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
import { resolvePoiIconPath } from "@openmapx/core";

// Populated by setup(ctx); see setPhotonUrl.
let PHOTON_URL = "https://photon.komoot.io";

/** Update the Photon base URL (called from setup() when service registry resolves it). */
export function setPhotonUrl(url: string): void {
  PHOTON_URL = url;
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const res = await fetch(url.toString(), {
      headers: { "Accept-Language": lang ?? "en" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Photon error ${res.status}`);
    return res.json() as Promise<PhotonResponse>;
  } finally {
    clearTimeout(timer);
  }
}

export const photonService: GeocodingProviderImpl = {
  async geocode(query: string, lang?: string, proximity?: LngLat): Promise<SearchResult[]> {
    const params: Record<string, string> = { q: query, limit: "10", lang: lang ?? "en" };
    if (proximity) {
      params.lat = String(proximity[1]);
      params.lon = String(proximity[0]);
    }
    const data = await fetchPhoton(params, "/api", lang);
    return data.features.map((f) => ({
      id: makeId(f.properties),
      label: buildLabel(f.properties),
      coordinates: f.geometry.coordinates,
      type: mapType(f.properties.osm_key),
      confidence: 1,
      rawCategory: `${f.properties.osm_key}/${f.properties.osm_value}`,
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

  async autocomplete(query: string, lang?: string): Promise<AutocompleteResult[]> {
    const data = await fetchPhoton({ q: query, limit: "6", lang: lang ?? "en" }, "/api", lang);
    return data.features.map((f) => {
      const short = f.properties.name ?? buildLabel(f.properties);
      const full = buildLabel(f.properties);
      return {
        id: makeId(f.properties),
        label: short,
        sublabel: short !== full ? full : undefined,
        coordinates: f.geometry.coordinates,
        type: mapType(f.properties.osm_key),
        iconPath: resolvePoiIconPath(f.properties.osm_value),
        rawCategory: `${f.properties.osm_key}/${f.properties.osm_value}`,
      };
    });
  },
};
