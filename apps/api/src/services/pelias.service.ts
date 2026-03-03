/**
 * Pelias geocoding client (self-hosted).
 * Set PELIAS_URL to your Pelias instance (e.g. http://localhost:4000).
 * https://github.com/pelias/pelias
 */

import type { AutocompleteResult, SearchResult } from "@openmapx/core";
import type { GeocodingProvider } from "./geocoding.provider";

const PELIAS_URL = process.env.PELIAS_URL ?? "http://localhost:4000";

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

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Pelias error ${res.status}: ${url.toString()}`);
  return res.json() as Promise<PeliasResponse>;
}

export const peliasService: GeocodingProvider = {
  async geocode(query: string): Promise<SearchResult[]> {
    const data = await fetchPelias("/v1/search", { text: query, size: "10" });
    return data.features.map((f) => ({
      id: f.properties.gid,
      label: f.properties.label,
      coordinates: f.geometry.coordinates,
      type: mapLayer(f.properties.layer),
      confidence: f.properties.confidence,
    }));
  },

  async autocomplete(query: string): Promise<AutocompleteResult[]> {
    const data = await fetchPelias("/v1/autocomplete", { text: query, size: "6" });
    return data.features.map((f) => {
      const p = f.properties;
      const sublabelParts = [p.locality, p.region, p.country].filter(Boolean);
      const sublabel = sublabelParts.length > 0 ? sublabelParts.join(", ") : undefined;
      return {
        id: p.gid,
        label: p.name,
        sublabel,
        coordinates: f.geometry.coordinates,
        type: mapLayer(p.layer),
      };
    });
  },
};
