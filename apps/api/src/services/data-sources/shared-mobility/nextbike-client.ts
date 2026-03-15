/**
 * Nextbike API client.
 * Covers 300+ cities across 30+ countries with a single open endpoint.
 * https://github.com/ubahnverleih/WoBike/blob/master/Nextbike.md
 */

import type { BoundingBox, LngLat } from "@openmapx/core";
import { withCache } from "../../../utils/cache.js";
import type { SharedMobilityStation } from "./types.js";

const NEXTBIKE_URL = "https://maps.nextbike.net/maps/nextbike-live.json";
const HEADERS = { "User-Agent": "OpenMapX/1.0 (https://github.com/openmapx)" };
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_KEY = "shared-mobility:nextbike:all";
const CACHE_TTL = 120; // 2min — real-time availability

interface NextbikeCountry {
  country: string;
  country_name: string;
  cities: NextbikeCity[];
}

interface NextbikeCity {
  uid: number;
  name: string;
  alias: string;
  lat: number;
  lng: number;
  available_bikes: number;
  places: NextbikePlace[];
}

interface NextbikePlace {
  uid: number;
  name: string;
  lat: number;
  lng: number;
  bikes: number;
  bike_racks: number;
  free_racks: number;
  spot: boolean; // true = docking station, false = free-floating
  bike_list?: NextbikeBike[];
}

interface NextbikeBike {
  number: string;
  bike_type: number;
  active: boolean;
}

function bboxContains(bbox: BoundingBox, lat: number, lng: number): boolean {
  return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
}

/**
 * Fetch the global Nextbike dataset and extract stations within the bbox.
 */
export async function searchNextbike(bbox: BoundingBox): Promise<SharedMobilityStation[]> {
  const allData = await withCache<NextbikeCountry[]>(CACHE_KEY, CACHE_TTL, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(NEXTBIKE_URL, { headers: HEADERS, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Nextbike API error: ${res.status}`);
    const json = (await res.json()) as { countries: NextbikeCountry[] };
    return json.countries;
  });

  const stations: SharedMobilityStation[] = [];

  for (const country of allData) {
    for (const city of country.cities) {
      // Quick city-level check: skip if city center is far from bbox
      // (rough heuristic — cities span ~0.5° typically)
      if (
        city.lat < bbox.south - 0.5 ||
        city.lat > bbox.north + 0.5 ||
        city.lng < bbox.west - 0.5 ||
        city.lng > bbox.east + 0.5
      ) {
        continue;
      }

      const operator = city.name || country.country_name;

      for (const place of city.places) {
        if (!bboxContains(bbox, place.lat, place.lng)) continue;

        stations.push({
          id: `nextbike/${city.uid}/${place.uid}`,
          name: place.name,
          coordinates: [place.lng, place.lat] as LngLat,
          availableVehicles: place.bikes,
          emptySlots: place.free_racks > 0 ? place.free_racks : undefined,
          capacity: place.bike_racks > 0 ? place.bike_racks : undefined,
          operator,
          vehicleTypes: ["bicycle"],
          isActive: place.bikes > 0 || place.free_racks > 0,
          source: `nextbike/${city.uid}`,
          attribution: { label: "Nextbike", url: "https://www.nextbike.net" },
        });
      }
    }
  }

  return stations;
}
