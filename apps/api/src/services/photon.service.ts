/**
 * Photon geocoding client (by Komoot).
 * Backed by OSM data. No API key required.
 * Override with PHOTON_URL for a self-hosted instance.
 * https://photon.komoot.io
 */

import type { AutocompleteResult, ReverseGeocodingResult, SearchResult } from "@openmapx/core";
import { resolvePoiIconPath } from "@openmapx/core";
import type { GeocodingProvider } from "./geocoding.provider";

const PHOTON_URL = process.env.PHOTON_URL ?? "https://photon.komoot.io";

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

function makeId(p: PhotonProperties): string {
  return `${p.osm_type.toLowerCase()}/${p.osm_id}`;
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

async function fetchPhoton(params: Record<string, string>, path = "/api"): Promise<PhotonResponse> {
  const url = new URL(`${PHOTON_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: { "Accept-Language": "en" },
  });
  if (!res.ok) throw new Error(`Photon error ${res.status}`);
  return res.json() as Promise<PhotonResponse>;
}

export const photonService: GeocodingProvider = {
  async geocode(query: string): Promise<SearchResult[]> {
    const data = await fetchPhoton({ q: query, limit: "10", lang: "en" });
    return data.features.map((f) => ({
      id: makeId(f.properties),
      label: buildLabel(f.properties),
      coordinates: f.geometry.coordinates,
      type: mapType(f.properties.osm_key),
      confidence: 1,
      rawCategory: `${f.properties.osm_key}/${f.properties.osm_value}`,
    }));
  },

  async reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodingResult | null> {
    const data = await fetchPhoton({ lat: String(lat), lon: String(lng), limit: "1" }, "/reverse");
    const f = data.features[0];
    if (!f) return null;

    const p = f.properties;
    const city = [p.city, p.state].filter(Boolean).join(", ");
    return { address: buildLabel(p), city };
  },

  async autocomplete(query: string): Promise<AutocompleteResult[]> {
    const data = await fetchPhoton({ q: query, limit: "6", lang: "en" });
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
