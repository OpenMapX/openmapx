import type { BoundingBox } from "../types/geometry";
import { overpassQuery } from "./overpass";

const MAX_RESULTS = 50;

export type { BoundingBox };

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
  schools: [
    { key: "amenity", value: "school" },
    { key: "amenity", value: "university" },
    { key: "amenity", value: "college" },
  ],
  kindergartens: [
    { key: "amenity", value: "kindergarten" },
    { key: "amenity", value: "childcare" },
  ],
  ambulance_stations: [
    { key: "amenity", value: "ambulance_station" },
    { key: "emergency", value: "ambulance_station" },
  ],
  fire_stations: [{ key: "amenity", value: "fire_station" }],
  police: [{ key: "amenity", value: "police" }],
  parks: [
    { key: "leisure", value: "park" },
    { key: "leisure", value: "nature_reserve" },
    { key: "leisure", value: "garden" },
  ],
  churches: [
    { key: "amenity", value: "place_of_worship" },
    { key: "building", value: "church" },
    { key: "building", value: "chapel" },
  ],
  post_offices: [{ key: "amenity", value: "post_office" }],
  ev_charging: [{ key: "amenity", value: "charging_station" }],
  swimming: [
    { key: "leisure", value: "swimming_pool" },
    { key: "leisure", value: "water_park" },
    { key: "sport", value: "swimming" },
  ],
  nightlife: [
    { key: "amenity", value: "nightclub" },
    { key: "amenity", value: "casino" },
    { key: "amenity", value: "stripclub" },
  ],
  bakeries: [
    { key: "shop", value: "bakery" },
    { key: "shop", value: "pastry" },
  ],
  aeds: [{ key: "emergency", value: "defibrillator" }],
  toilets: [{ key: "amenity", value: "toilets" }],
  laundromats: [
    { key: "shop", value: "laundry" },
    { key: "shop", value: "laundromat" },
  ],
  hairdressers: [
    { key: "shop", value: "hairdresser" },
    { key: "shop", value: "beauty" },
    { key: "shop", value: "barber" },
  ],
  opticians: [
    { key: "shop", value: "optician" },
    { key: "healthcare", value: "optometrist" },
  ],
  recycling: [{ key: "amenity", value: "recycling" }],
  car_rental: [{ key: "amenity", value: "car_rental" }],
  car_sharing: [{ key: "amenity", value: "car_sharing" }],
  bicycle_rental: [{ key: "amenity", value: "bicycle_rental" }],
  airports: [
    { key: "aeroway", value: "aerodrome" },
    { key: "aeroway", value: "terminal" },
  ],
  beaches: [{ key: "natural", value: "beach" }],
  viewpoints: [{ key: "tourism", value: "viewpoint" }],
  camping: [
    { key: "tourism", value: "camp_site" },
    { key: "tourism", value: "caravan_site" },
  ],
  dog_parks: [{ key: "leisure", value: "dog_park" }],
  drinking_water: [{ key: "amenity", value: "drinking_water" }],
  veterinarians: [{ key: "amenity", value: "veterinary" }],
  blood_donation: [{ key: "healthcare", value: "blood_donation" }],
  mosques: [
    { key: "building", value: "mosque" },
    { key: "amenity", value: "mosque" },
  ],
  synagogues: [
    { key: "building", value: "synagogue" },
    { key: "amenity", value: "synagogue" },
  ],
  temples: [
    { key: "building", value: "temple" },
    { key: "building", value: "shrine" },
    { key: "amenity", value: "temple" },
  ],
  markets: [{ key: "amenity", value: "marketplace" }],
  shopping_malls: [
    { key: "shop", value: "mall" },
    { key: "shop", value: "department_store" },
  ],
  bookstores: [{ key: "shop", value: "books" }],
};

export interface CategoryPlaceResult {
  id: string;
  name: string;
  coordinates: [number, number];
  category?: string;
  address?: string;
  phone?: string;
  website?: string;
  openingHours?: string;
  isOpen?: boolean;
  fuelPrices?: { e5?: number; e10?: number; diesel?: number };
  fuelPricesUpdatedAt?: string;
  fuelAttribution?: { label: string; url: string };
}

function buildCategoryQuery(filters: OsmFilter[], bbox: BoundingBox): string {
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
    tags.emergency ??
    tags.shop ??
    tags.sport ??
    tags.building ??
    tags.natural ??
    tags.aeroway ??
    tags.healthcare ??
    undefined
  );
}

export async function searchByCategory(
  filters: OsmFilter[],
  bbox: BoundingBox,
): Promise<CategoryPlaceResult[]> {
  const query = buildCategoryQuery(filters, bbox);
  const data = await overpassQuery(query);

  const results: CategoryPlaceResult[] = [];

  for (const el of data.elements) {
    const tags = el.tags ?? {};
    const name =
      tags.name ??
      (tags.emergency === "defibrillator" ? "Defibrillator" : undefined) ??
      (tags.amenity === "toilets" ? "Toilet" : undefined) ??
      (tags.amenity === "recycling" ? "Recycling" : undefined) ??
      (tags.amenity === "drinking_water" ? "Drinking Water" : undefined) ??
      (tags.natural === "beach" ? "Beach" : undefined) ??
      (tags.tourism === "viewpoint" ? "Viewpoint" : undefined) ??
      (tags.leisure === "dog_park" ? "Dog Park" : undefined) ??
      (tags.healthcare === "blood_donation" ? "Blood Donation" : undefined) ??
      (tags.aeroway === "aerodrome" ? "Airport" : undefined) ??
      (tags.aeroway === "terminal" ? "Airport Terminal" : undefined);
    if (!name) continue;

    let lat: number;
    let lon: number;
    if (el.type === "node") {
      lat = el.lat;
      lon = el.lon;
    } else if (el.type === "way" && el.center) {
      lat = el.center.lat;
      lon = el.center.lon;
    } else {
      continue;
    }

    results.push({
      id: `osm:${el.type}/${el.id}`,
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
