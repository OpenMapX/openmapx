/**
 * Dott e-scooter & e-bike client.
 * Uses Dott's public GBFS endpoints — no authentication needed.
 * Covers 68+ German cities and many more across Europe.
 *
 * Discovery: GET https://gbfs.api.ridedott.com/public/v2/countries/{cc}/gbfs.json
 * Per-city:  GET https://gbfs.api.ridedott.com/public/v2/{city}/free_bike_status.json
 */

import type { BoundingBox, LngLat } from "@openmapx/core";
import { withCache } from "../../../utils/cache.js";
import { reverseGeocodeCity } from "../../nominatim-lookup.service.js";
import type { SharedMobilityVehicle, VehicleFormFactor } from "./types.js";

const DOTT_BASE = "https://gbfs.api.ridedott.com/public/v2";
const HEADERS = { "User-Agent": "OpenMapX/1.0 (https://github.com/openmapx)" };
const FETCH_TIMEOUT_MS = 8_000;

/** Country codes where Dott operates. */
const DOTT_COUNTRIES = ["de", "at", "be", "dk", "es", "fi", "fr", "gb", "it", "nl", "pt", "se"];

interface DottCityIndex {
  slug: string;
  /** Approximate center lat/lng (from first batch of vehicles). */
  lat?: number;
  lng?: number;
}

interface DottVehicle {
  bike_id: string;
  lat: number;
  lon: number;
  is_reserved: boolean;
  is_disabled: boolean;
  vehicle_type_id?: string;
  current_range_meters?: number;
  current_fuel_percent?: number;
}

interface DottFreeBikeResponse {
  data: { bikes: DottVehicle[] };
}

// In-memory city index
let cityIndex: DottCityIndex[] | null = null;
let cityIndexLoadedAt = 0;
const INDEX_REFRESH_MS = 24 * 60 * 60 * 1000;

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Build city index from Dott's countries endpoints.
 * Extracts city slugs from the feed URLs.
 */
async function loadCityIndex(): Promise<DottCityIndex[]> {
  if (cityIndex && Date.now() - cityIndexLoadedAt < INDEX_REFRESH_MS) {
    return cityIndex;
  }

  const cached = await withCache<DottCityIndex[]>(
    "shared-mobility:dott:cities",
    86_400,
    async () => {
      const allCities: DottCityIndex[] = [];
      const seen = new Set<string>();

      const results = await Promise.allSettled(
        DOTT_COUNTRIES.map(async (cc) => {
          const url = `${DOTT_BASE}/countries/${cc}/gbfs.json`;
          const data = await fetchJson<{
            data: { en?: { feeds: { name: string; url: string }[] } };
          }>(url);
          if (!data?.data?.en?.feeds) return [];

          const slugs = new Set<string>();
          for (const feed of data.data.en.feeds) {
            // Extract city slug from URL: .../public/v2/{city}/free_bike_status.json
            const match = feed.url.match(
              /\/v2\/([^/]+)\/(?:free_bike|station_|system_|vehicle_|geofencing)/,
            );
            if (match?.[1] && match[1] !== "countries") {
              slugs.add(match[1]);
            }
          }
          return Array.from(slugs);
        }),
      );

      for (const r of results) {
        if (r.status === "fulfilled") {
          for (const slug of r.value) {
            if (!seen.has(slug)) {
              seen.add(slug);
              allCities.push({ slug });
            }
          }
        }
      }
      return allCities;
    },
  );

  cityIndex = cached;
  cityIndexLoadedAt = Date.now();
  return cached;
}

// Per-city vehicle data cache (in-memory, short TTL)
const vehicleCache = new Map<string, { vehicles: SharedMobilityVehicle[]; expiresAt: number }>();
const VEHICLE_CACHE_TTL_MS = 120_000; // 2min

/**
 * Fetch Dott vehicles for a specific city slug.
 */
async function fetchCityVehicles(slug: string): Promise<SharedMobilityVehicle[]> {
  const cached = vehicleCache.get(slug);
  if (cached && cached.expiresAt > Date.now()) return cached.vehicles;

  const data = await fetchJson<DottFreeBikeResponse>(`${DOTT_BASE}/${slug}/free_bike_status.json`);
  if (!data?.data?.bikes) return [];

  const vehicles: SharedMobilityVehicle[] = data.data.bikes
    .filter((v) => !v.is_reserved && !v.is_disabled && v.lat && v.lon)
    .map((v): SharedMobilityVehicle => {
      const formFactor: VehicleFormFactor = v.vehicle_type_id?.includes("bicycle")
        ? "bicycle"
        : "scooter_standing";
      return {
        id: `dott/${slug}/${v.bike_id}`,
        coordinates: [v.lon, v.lat] as LngLat,
        formFactor,
        propulsion: formFactor === "bicycle" ? "electric_assist" : "electric",
        batteryLevel:
          v.current_fuel_percent != null ? Math.round(v.current_fuel_percent * 100) : undefined,
        rangeMeters: v.current_range_meters,
        isReserved: v.is_reserved,
        isDisabled: v.is_disabled,
        operator: "Dott",
        source: `dott/${slug}`,
        attribution: {
          label: "Dott",
          url: "https://ridedott.com",
          license: "Proprietary",
          licenseUrl: "https://ridedott.com/api-licence/",
        },
      };
    });

  vehicleCache.set(slug, { vehicles, expiresAt: Date.now() + VEHICLE_CACHE_TTL_MS });
  return vehicles;
}

// City center cache — populated lazily from first vehicle data
const cityCenterCache = new Map<string, { lat: number; lng: number }>();

function bboxContains(bbox: BoundingBox, lat: number, lng: number): boolean {
  return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
}

/**
 * Heuristic: estimate if a city slug might be in the bbox area.
 * Uses cached city centers from previous fetches, or queries cities
 * whose names match common patterns.
 */
function cityMightBeInBbox(slug: string, bbox: BoundingBox): boolean {
  const center = cityCenterCache.get(slug);
  if (center) {
    // Check with generous padding (~30km)
    const pad = 0.3;
    return (
      center.lat >= bbox.south - pad &&
      center.lat <= bbox.north + pad &&
      center.lng >= bbox.west - pad &&
      center.lng <= bbox.east + pad
    );
  }
  // Unknown city center — include it (will be filtered by coordinates after fetch)
  return true;
}

/**
 * Search Dott vehicles within a bounding box.
 * Fetches from matching city feeds and filters to bbox.
 */
export async function searchDott(
  bbox: BoundingBox,
  targetFormFactors: Set<VehicleFormFactor>,
): Promise<SharedMobilityVehicle[]> {
  const cities = await loadCityIndex();
  const candidates = cities.filter((c) => cityMightBeInBbox(c.slug, bbox));

  // Reverse-geocode bbox center to prioritize matching city slugs
  const centerLat = (bbox.south + bbox.north) / 2;
  const centerLon = (bbox.west + bbox.east) / 2;
  const city = await reverseGeocodeCity(centerLat, centerLon);
  const cityLower = city?.toLowerCase() ?? null;

  // Sort: matching city slug first, then rest (avoids cold-start ordering issues)
  const sorted = cityLower
    ? [...candidates].sort((a, b) => {
        const aMatch = a.slug.includes(cityLower) ? 1 : 0;
        const bMatch = b.slug.includes(cityLower) ? 1 : 0;
        return bMatch - aMatch;
      })
    : candidates;

  console.log(
    `[dott] ${cities.length} total cities, ${candidates.length} candidates for bbox, city="${city}"`,
  );

  // Limit concurrent city fetches
  const limited = sorted.slice(0, 30);

  const results = await Promise.allSettled(limited.map((c) => fetchCityVehicles(c.slug)));

  const vehicles: SharedMobilityVehicle[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const v of r.value) {
      if (!bboxContains(bbox, v.coordinates[1], v.coordinates[0])) continue;
      if (!targetFormFactors.has(v.formFactor)) continue;
      vehicles.push(v);

      // Update city center cache from vehicle coordinates
      const slug = v.source.replace("dott/", "");
      if (!cityCenterCache.has(slug)) {
        cityCenterCache.set(slug, { lat: v.coordinates[1], lng: v.coordinates[0] });
      }
    }
  }

  return vehicles;
}
