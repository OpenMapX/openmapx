import type { GeocodingProviderImpl } from "./types.js";
/**
 * Pelias geocoding client (self-hosted).
 * Set PELIAS_URL to your Pelias instance (e.g. http://localhost:4000).
 * https://github.com/pelias/pelias
 */

import type { AutocompleteResult, ReverseGeocodingResult, SearchResult } from "@openmapx/core";

// Populated by setup(ctx); see setPeliasUrl.
let PELIAS_URL = "http://localhost:4000";

/** Update the Pelias base URL (called from setup() when service registry resolves it). */
export function setPeliasUrl(url: string): void {
  PELIAS_URL = url;
}

interface PeliasGeometry {
  coordinates: [number, number];
}

interface PeliasProperties {
  gid: string;
  label: string;
  name: string;
  layer: string;
  confidence: number;
  locality?: string;
  region?: string;
  country?: string;
}

interface PeliasFeature {
  geometry: PeliasGeometry;
  properties: PeliasProperties;
}

interface PeliasResponse {
  features: PeliasFeature[];
}

/**
 * Convert a Pelias gid to a canonical `scheme:value` place id.
 *
 * Pelias gids look like `<source>:<layer>:<id>` — e.g.
 * `openstreetmap:venue:node/123456` or `whosonfirst:locality:85682183`.
 * When the source is openstreetmap and the inner id is a canonical OSM
 * ref, emit `osm:<ref>` so the place route's OSM resolver can enrich it;
 * otherwise wrap under a `pelias-<source>:` scheme so the id still round-
 * trips through `parseId` without colliding with other schemes.
 */
function makeIdFromGid(gid: string): string {
  const [source, _layer, ...rest] = gid.split(":");
  const inner = rest.join(":");
  if (source === "openstreetmap" && /^(node|way|relation)\/\d+/.test(inner)) {
    return `osm:${inner}`;
  }
  return `pelias-${source}:${inner || gid}`;
}

function mapLayer(layer: string): SearchResult["type"] {
  if (layer === "venue") return "poi";
  if (layer === "address") return "address";
  if (layer === "street") return "street";
  if (
    layer === "locality" ||
    layer === "localadmin" ||
    layer === "county" ||
    layer === "region" ||
    layer === "country" ||
    layer === "continent"
  )
    return "region";
  return "poi";
}

async function fetchPelias(path: string, params: Record<string, string>): Promise<PeliasResponse> {
  const url = new URL(`${PELIAS_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) throw new Error(`Pelias error ${res.status}: ${url.toString()}`);
    return res.json() as Promise<PeliasResponse>;
  } finally {
    clearTimeout(timer);
  }
}

export const peliasService: GeocodingProviderImpl = {
  async geocode(query: string, lang?: string): Promise<SearchResult[]> {
    const params: Record<string, string> = { text: query, size: "10" };
    if (lang) params.lang = lang;
    const data = await fetchPelias("/v1/search", params);
    return data.features.map((f) => ({
      id: makeIdFromGid(f.properties.gid),
      label: f.properties.label,
      coordinates: f.geometry.coordinates,
      type: mapLayer(f.properties.layer),
      confidence: f.properties.confidence,
    }));
  },

  async reverseGeocode(
    lat: number,
    lng: number,
    lang?: string,
  ): Promise<ReverseGeocodingResult | null> {
    const params: Record<string, string> = {
      "point.lat": String(lat),
      "point.lon": String(lng),
      size: "1",
    };
    if (lang) params.lang = lang;
    const data = await fetchPelias("/v1/reverse", params);
    const f = data.features[0];
    if (!f) return null;

    const p = f.properties;
    const city = [p.locality, p.region].filter(Boolean).join(", ");
    return { address: p.label, city };
  },

  async autocomplete(query: string, lang?: string): Promise<AutocompleteResult[]> {
    const params: Record<string, string> = { text: query, size: "6" };
    if (lang) params.lang = lang;
    const data = await fetchPelias("/v1/autocomplete", params);
    return data.features.map((f) => {
      const p = f.properties;
      const sublabelParts = [p.locality, p.region, p.country].filter(Boolean);
      const sublabel = sublabelParts.length > 0 ? sublabelParts.join(", ") : undefined;
      return {
        id: makeIdFromGid(p.gid),
        label: p.name,
        sublabel,
        coordinates: f.geometry.coordinates,
        type: mapLayer(p.layer),
      };
    });
  },
};
