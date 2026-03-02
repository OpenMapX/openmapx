/**
 * Pelias geocoding service client.
 * Translates Pelias GeoJSON responses to the OpenMapX SearchResult/AutocompleteResult shapes.
 */

const PELIAS_URL = process.env.PELIAS_URL ?? "http://localhost:4000/v1";

interface PeliasFeature {
  properties: {
    id: string;
    label: string;
    name: string;
    layer: string;
    confidence: number;
    addendum?: { osm?: { postcode?: string } };
  };
  geometry: { coordinates: [number, number] };
}

interface PeliasResponse {
  features: PeliasFeature[];
}

function mapLayer(layer: string): "address" | "poi" | "street" | "region" {
  if (layer === "address") return "address";
  if (layer === "street") return "street";
  if (layer === "region" || layer === "country" || layer === "locality") return "region";
  return "poi";
}

async function fetchPelias(path: string, params: Record<string, string>): Promise<PeliasResponse> {
  const url = new URL(`${PELIAS_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Pelias error ${res.status}`);
  return res.json() as Promise<PeliasResponse>;
}

export const peliasService = {
  async geocode(query: string) {
    const data = await fetchPelias("/search", { text: query, size: "10" });
    return data.features.map((f) => ({
      id: f.properties.id,
      label: f.properties.label,
      coordinates: f.geometry.coordinates,
      type: mapLayer(f.properties.layer),
      confidence: f.properties.confidence,
    }));
  },

  async autocomplete(query: string) {
    const data = await fetchPelias("/autocomplete", { text: query, size: "6" });
    return data.features.map((f) => ({
      id: f.properties.id,
      label: f.properties.name,
      sublabel: f.properties.label,
      coordinates: f.geometry.coordinates,
      type: mapLayer(f.properties.layer),
    }));
  },
};
