import type { BoundingBox } from "@openmapx/core";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import {
  bboxOverlaps,
  fetchMobidromSites,
  filterByBbox,
  mapMobidromSite,
} from "./mobidrom-common.js";

/**
 * APAG - Aachener Parkhaus GmbH feed via NRW Mobidrom.
 *
 * Operator-managed garages in Aachen with real-time occupancy. Only ~20 sites
 * but all report live `availableSpaces`, making this richer than the aggregate
 * `parken-nrw` feed's APAG subset (which has static data only).
 */

const API_URL =
  "https://www.mobilitaetsdaten.nrw/api/systemadapter-mobilithek-exporter/parkplaetze-apag.json";
const CACHE_TTL = 5 * 60 * 1000;
const OPERATOR_NAME = "APAG - Aachener Parkhaus GmbH";

const COVERAGE_BBOX: BoundingBox = { south: 50.65, west: 5.9, north: 50.9, east: 6.3 };

let cache: { facilities: ParkingFacility[]; fetchedAt: number } | null = null;

async function fetchAllFacilities(): Promise<ParkingFacility[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL) return cache.facilities;

  const sites = await fetchMobidromSites(API_URL, CACHE_TTL);
  const facilities: ParkingFacility[] = [];
  for (const site of sites) {
    const facility = mapMobidromSite(site, {
      idPrefix: "apag",
      sourceId: "apag",
      operatorName: OPERATOR_NAME,
    });
    if (facility) facilities.push(facility);
  }

  cache = { facilities, fetchedAt: Date.now() };
  return facilities;
}

export async function searchApag(bbox: BoundingBox): Promise<ParkingFacility[]> {
  if (!bboxOverlaps(bbox, COVERAGE_BBOX)) return [];
  const all = await fetchAllFacilities();
  return filterByBbox(all, bbox);
}

export async function fetchApagDetail(externalId: string): Promise<ParkingFacility | null> {
  const all = await fetchAllFacilities();
  return all.find((f) => f.id === `apag:${externalId}`) ?? null;
}
