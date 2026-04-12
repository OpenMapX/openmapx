import type { BoundingBox } from "@openmapx/core";
import type { ParkApiV2City, ParkApiV2Lot, ParkingFacility, ParkingType } from "./types.js";

const API_BASE = "https://api.parkendd.de";
const CITY_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

let cityCache: { cities: Map<string, ParkApiV2City>; fetchedAt: number } | null = null;

const LOT_TYPE_MAP: Record<string, ParkingType> = {
  Tiefgarage: "underground",
  Parkhaus: "garage",
  Parkplatz: "surface",
};

function mapLotType(lotType?: string): ParkingType {
  if (!lotType) return "unknown";
  return LOT_TYPE_MAP[lotType] ?? "unknown";
}

function mapState(state?: string): "open" | "closed" | "unknown" {
  if (state === "open") return "open";
  if (state === "closed") return "closed";
  return "unknown";
}

async function fetchCityList(): Promise<Map<string, ParkApiV2City>> {
  if (cityCache && Date.now() - cityCache.fetchedAt < CITY_CACHE_TTL) {
    return cityCache.cities;
  }

  const res = await fetch(API_BASE, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    if (cityCache) return cityCache.cities;
    throw new Error(`ParkenDD city list failed: ${res.status}`);
  }

  const raw = (await res.json()) as { cities?: Record<string, ParkApiV2City> };
  const cityMap = raw.cities ?? {};
  const cities = new Map<string, ParkApiV2City>();
  for (const [name, city] of Object.entries(cityMap)) {
    if (city.coords) {
      cities.set(name, { ...city, name });
    }
  }

  cityCache = { cities, fetchedAt: Date.now() };
  return cities;
}

/** Expand bbox by ~10km to catch cities near the edge. */
function expandBbox(bbox: BoundingBox, margin = 0.1): BoundingBox {
  return {
    south: bbox.south - margin,
    west: bbox.west - margin,
    north: bbox.north + margin,
    east: bbox.east + margin,
  };
}

function citiesInBbox(cities: Map<string, ParkApiV2City>, bbox: BoundingBox): string[] {
  const expanded = expandBbox(bbox);
  const result: string[] = [];
  for (const [name, city] of cities) {
    if (!city.active_support) continue;
    const { lat, lng } = city.coords;
    if (
      lat >= expanded.south &&
      lat <= expanded.north &&
      lng >= expanded.west &&
      lng <= expanded.east
    ) {
      result.push(name);
    }
  }
  return result;
}

async function fetchCityLots(cityName: string): Promise<ParkApiV2Lot[]> {
  const url = `${API_BASE}/${encodeURIComponent(cityName)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return [];

  const data = (await res.json()) as { lots?: ParkApiV2Lot[] };
  return data.lots ?? [];
}

function lotToFacility(
  lot: ParkApiV2Lot,
  cityName: string,
  _cityData: ParkApiV2City,
): ParkingFacility | null {
  if (!lot.coords) return null;

  const hasRealtime = lot.free !== undefined && lot.free !== null;
  return {
    id: `parkapi-v2:${cityName}/${lot.id}`,
    name: lot.name,
    coordinates: [lot.coords.lng, lot.coords.lat],
    sources: [`parkapi-v2/${cityName}`],
    parkingType: mapLotType(lot.lot_type),
    capacity: lot.total ?? undefined,
    freeSpaces: hasRealtime ? lot.free : undefined,
    hasRealtimeData: hasRealtime,
    state: mapState(lot.state),
    address: lot.address ?? undefined,
  };
}

export async function searchParkApiV2(bbox: BoundingBox): Promise<ParkingFacility[]> {
  const cities = await fetchCityList();
  const matchingCities = citiesInBbox(cities, bbox);
  if (matchingCities.length === 0) return [];

  const results = await Promise.allSettled(matchingCities.map((name) => fetchCityLots(name)));

  const facilities: ParkingFacility[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status !== "fulfilled") continue;

    const cityName = matchingCities[i];
    const cityData = cities.get(cityName);
    if (!cityData) continue;

    for (const lot of result.value) {
      const facility = lotToFacility(lot, cityName, cityData);
      if (facility) facilities.push(facility);
    }
  }

  return facilities;
}

export async function fetchParkApiV2Detail(
  cityName: string,
  lotId: string,
): Promise<ParkingFacility | null> {
  const cities = await fetchCityList();
  const cityData = cities.get(cityName);
  if (!cityData) return null;

  const lots = await fetchCityLots(cityName);
  const lot = lots.find((l) => l.id === lotId);
  if (!lot) return null;

  return lotToFacility(lot, cityName, cityData);
}
