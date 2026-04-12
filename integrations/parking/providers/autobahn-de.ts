/**
 * German Autobahn rest area / truck parking client.
 *
 * Uses the Autobahn GmbH public API (verkehr.autobahn.de) for ~1,700
 * truck and car parking rest areas along German highways.
 * Static capacity data with blocked/open status. No real-time occupancy.
 *
 * License: GovData (Datenlizenz Deutschland). No authentication required.
 */

import type { BoundingBox } from "@openmapx/core";
import type { AutobahnParkingLorry, ParkingFacility } from "./types.js";

const BASE_URL = "https://verkehr.autobahn.de/o/autobahn";
const CACHE_TTL = 30 * 60 * 1000; // 30 min — data is essentially static
const BATCH_SIZE = 10;

const COVERAGE_BBOX = { south: 47.2, west: 5.8, north: 55.1, east: 15.1 };

let listCache: { facilities: ParkingFacility[]; fetchedAt: number } | null = null;

function overlapsCoverage(bbox: BoundingBox): boolean {
  return (
    bbox.south <= COVERAGE_BBOX.north &&
    bbox.north >= COVERAGE_BBOX.south &&
    bbox.west <= COVERAGE_BBOX.east &&
    bbox.east >= COVERAGE_BBOX.west
  );
}

function parseCapacity(description: string[]): { car?: number; truck?: number } {
  let car: number | undefined;
  let truck: number | undefined;

  for (const line of description) {
    const carMatch = line.match(/PKW\s*Stellpl[aä]tze:\s*(\d+)/i);
    if (carMatch) car = parseInt(carMatch[1], 10);

    const truckMatch = line.match(/LKW\s*Stellpl[aä]tze:\s*(\d+)/i);
    if (truckMatch) truck = parseInt(truckMatch[1], 10);
  }

  return { car, truck };
}

function hasAmenity(
  icons: AutobahnParkingLorry["lorryParkingFeatureIcons"],
  keyword: string,
): boolean {
  return icons?.some((i) => i.icon.includes(keyword) || i.description.includes(keyword)) ?? false;
}

function itemToFacility(item: AutobahnParkingLorry): ParkingFacility | null {
  const lat = parseFloat(item.coordinate?.lat);
  const lng = parseFloat(item.coordinate?.long);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  if (item.future === true) return null;

  const { car, truck } = parseCapacity(item.description ?? []);
  const totalCapacity = (car ?? 0) + (truck ?? 0);
  const isBlocked = item.isBlocked === "true";

  const icons = item.lorryParkingFeatureIcons ?? [];
  const hasCharging = hasAmenity(icons, "charging") || hasAmenity(icons, "Ladestation");

  return {
    id: `autobahn:${item.identifier}`,
    name: item.subtitle || item.title || "Rastplatz",
    coordinates: [lng, lat],
    sources: ["autobahn-de"],
    parkingType: "surface",
    capacity: totalCapacity > 0 ? totalCapacity : undefined,
    hasRealtimeData: false,
    fee: "free",
    state: isBlocked ? "closed" : "open",
    chargingSpaces: hasCharging ? 1 : undefined,
    chargingDetails: hasCharging ? "EV Charging Available" : undefined,
  };
}

async function fetchRoads(): Promise<string[]> {
  const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Autobahn roads API failed: ${res.status}`);
  const data = (await res.json()) as { roads: string[] };
  return data.roads ?? [];
}

async function fetchRoadParking(road: string): Promise<ParkingFacility[]> {
  const url = `${BASE_URL}/${encodeURIComponent(road)}/services/parking_lorry`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return [];
  const data = (await res.json()) as { parking_lorry: AutobahnParkingLorry[] };
  const items = data.parking_lorry ?? [];
  return items.map(itemToFacility).filter((f): f is ParkingFacility => f !== null);
}

async function fetchAllFacilities(): Promise<ParkingFacility[]> {
  if (listCache && Date.now() - listCache.fetchedAt < CACHE_TTL) {
    return listCache.facilities;
  }

  const roads = await fetchRoads();
  const allFacilities: ParkingFacility[] = [];

  for (let i = 0; i < roads.length; i += BATCH_SIZE) {
    const batch = roads.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(fetchRoadParking));
    for (const result of results) {
      if (result.status === "fulfilled") allFacilities.push(...result.value);
    }
  }

  // Deduplicate by identifier (same area can appear on multiple road segments)
  const seen = new Map<string, ParkingFacility>();
  for (const f of allFacilities) {
    if (!seen.has(f.id)) seen.set(f.id, f);
  }

  const facilities = Array.from(seen.values());
  listCache = { facilities, fetchedAt: Date.now() };
  return facilities;
}

export async function searchAutobahnDe(bbox: BoundingBox): Promise<ParkingFacility[]> {
  if (!overlapsCoverage(bbox)) return [];

  const allFacilities = await fetchAllFacilities();
  return allFacilities.filter((f) => {
    const [lng, lat] = f.coordinates;
    return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  });
}

export async function fetchAutobahnDeDetail(id: string): Promise<ParkingFacility | null> {
  const allFacilities = await fetchAllFacilities();
  return allFacilities.find((f) => f.id === `autobahn:${id}`) ?? null;
}
