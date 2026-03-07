const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const MAX_RESULTS = 50;

export interface OsmFilter {
  key: string;
  value: string;
}

/**
 * Overpass query filters for each category.
 * CategoryId strings are the shared contract with packages/core.
 * The OSM tag mappings are the API's own concern and live here.
 */
export const CATEGORY_FILTERS: Record<string, OsmFilter[]> = {
  restaurants: [
    { key: "amenity", value: "restaurant" },
    { key: "amenity", value: "cafe" },
    { key: "amenity", value: "fast_food" },
    { key: "amenity", value: "bar" },
    { key: "amenity", value: "pub" },
  ],
  hotels: [
    { key: "tourism", value: "hotel" },
    { key: "tourism", value: "hostel" },
    { key: "tourism", value: "motel" },
    { key: "tourism", value: "guest_house" },
    { key: "tourism", value: "apartment" },
  ],
  activities: [
    { key: "tourism", value: "attraction" },
    { key: "tourism", value: "theme_park" },
    { key: "tourism", value: "zoo" },
    { key: "tourism", value: "aquarium" },
    { key: "leisure", value: "park" },
    { key: "leisure", value: "playground" },
  ],
  museums: [
    { key: "tourism", value: "museum" },
    { key: "tourism", value: "gallery" },
  ],
  transit: [
    { key: "public_transport", value: "station" },
    { key: "railway", value: "station" },
    { key: "highway", value: "bus_stop" },
    { key: "railway", value: "tram_stop" },
    { key: "amenity", value: "ferry_terminal" },
  ],
  pharmacies: [{ key: "amenity", value: "pharmacy" }],
  atms: [{ key: "amenity", value: "atm" }],
  cafes: [{ key: "amenity", value: "cafe" }],
  bars: [
    { key: "amenity", value: "bar" },
    { key: "amenity", value: "pub" },
    { key: "amenity", value: "biergarten" },
  ],
  supermarkets: [
    { key: "shop", value: "supermarket" },
    { key: "shop", value: "grocery" },
    { key: "shop", value: "convenience" },
  ],
  hospitals: [{ key: "amenity", value: "hospital" }],
  doctors: [
    { key: "amenity", value: "doctors" },
    { key: "amenity", value: "clinic" },
  ],
  dentists: [{ key: "amenity", value: "dentist" }],
  gyms: [
    { key: "leisure", value: "fitness_centre" },
    { key: "leisure", value: "sports_centre" },
  ],
  libraries: [{ key: "amenity", value: "library" }],
  cinemas: [
    { key: "amenity", value: "cinema" },
    { key: "amenity", value: "theatre" },
  ],
  banks: [{ key: "amenity", value: "bank" }],
  car_repair: [
    { key: "shop", value: "car_repair" },
    { key: "amenity", value: "car_wash" },
  ],
  parking: [
    { key: "amenity", value: "parking" },
    { key: "amenity", value: "parking_space" },
  ],
  fuel: [{ key: "amenity", value: "fuel" }],
};

interface OverpassNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

interface OverpassWay {
  type: "way";
  id: number;
  center: { lat: number; lon: number };
  tags?: Record<string, string>;
}

type OverpassElement = OverpassNode | OverpassWay;

interface OverpassResponse {
  elements: OverpassElement[];
}

export interface CategoryPlaceResult {
  id: string;
  name: string;
  coordinates: [number, number];
  category?: string;
  address?: string;
  phone?: string;
  website?: string;
  openingHours?: string;
}

export interface BoundingBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

function buildOverpassQuery(filters: OsmFilter[], bbox: BoundingBox): string {
  const { south, west, north, east } = bbox;
  const bboxStr = `${south},${west},${north},${east}`;
  const lines = filters
    .flatMap((f) => [
      `node["${f.key}"="${f.value}"](${bboxStr});`,
      `way["${f.key}"="${f.value}"](${bboxStr});`,
    ])
    .join("\n  ");
  return `[out:json][timeout:15];\n(\n  ${lines}\n);\nout center ${MAX_RESULTS};`;
}

function formatAddress(tags: Record<string, string>): string | undefined {
  const street = tags["addr:street"];
  const number = tags["addr:housenumber"];
  if (street && number) return `${street} ${number}`;
  if (street) return street;
  return undefined;
}

function getCategoryValue(tags: Record<string, string>): string | undefined {
  return (
    tags.amenity ??
    tags.tourism ??
    tags.leisure ??
    tags.railway ??
    tags.highway ??
    tags.public_transport ??
    undefined
  );
}

export async function searchByCategory(
  filters: OsmFilter[],
  bbox: BoundingBox,
): Promise<CategoryPlaceResult[]> {
  const query = buildOverpassQuery(filters, bbox);
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
  });

  if (!res.ok) {
    throw new Error(`Overpass API error: ${res.status}`);
  }

  const data = (await res.json()) as OverpassResponse;

  const results: CategoryPlaceResult[] = [];

  for (const el of data.elements) {
    const tags = el.tags ?? {};
    const name = tags.name;
    if (!name) continue;

    const lat = el.type === "node" ? el.lat : el.center.lat;
    const lon = el.type === "node" ? el.lon : el.center.lon;

    results.push({
      id: `${el.type}/${el.id}`,
      name,
      coordinates: [lon, lat],
      category: getCategoryValue(tags),
      address: formatAddress(tags),
      phone: tags.phone ?? tags["contact:phone"] ?? undefined,
      website: tags.website ?? tags["contact:website"] ?? undefined,
      openingHours: tags.opening_hours ?? undefined,
    });
  }

  return results;
}
