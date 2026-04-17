import type { BoundingBox } from "@openmapx/core";
import {
  bboxOverlaps,
  fetchMobidromSites,
  filterByBbox,
  mapMobidromSite,
} from "./mobidrom-common.js";
import type { ParkingFacility } from "./types.js";

/**
 * NRW Mobidrom bundled parking feed.
 *
 * Aggregate dataset covering Düsseldorf, Köln, Bielefeld, Krefeld, Wuppertal,
 * Aachen (APAG), plus static data for APCOA and GOLDBECK operator locations.
 * Real-time occupancy for participating cities; static for operator feeds.
 *
 * Format: DATEX II "Parking Light" JSON (`mobidp.parking.ParkingSite$Bean`).
 * License: Datenlizenz Deutschland Namensnennung 2.0 (dl-de-by-20-1).
 * Update frequency: every minute per CKAN metadata.
 * No authentication required.
 */

const API_URL =
  "https://www.mobilitaetsdaten.nrw/api/systemadapter-mobilithek-exporter/parken-nrw.json";
const CACHE_TTL = 5 * 60 * 1000;

const COVERAGE_BBOX: BoundingBox = { south: 50.32, west: 5.87, north: 52.53, east: 9.46 };

let cache: { facilities: ParkingFacility[]; fetchedAt: number } | null = null;

async function fetchAllFacilities(): Promise<ParkingFacility[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL) return cache.facilities;

  const sites = await fetchMobidromSites(API_URL, CACHE_TTL);
  const facilities: ParkingFacility[] = [];
  for (const site of sites) {
    const facility = mapMobidromSite(site, {
      idPrefix: "nrw",
      sourceId: "nrw-mobidrom-parking",
    });
    if (facility) facilities.push(facility);
  }

  cache = { facilities, fetchedAt: Date.now() };
  return facilities;
}

export async function searchNrwMobidrom(bbox: BoundingBox): Promise<ParkingFacility[]> {
  if (!bboxOverlaps(bbox, COVERAGE_BBOX)) return [];
  const all = await fetchAllFacilities();
  return filterByBbox(all, bbox);
}

export async function fetchNrwMobidromDetail(externalId: string): Promise<ParkingFacility | null> {
  const all = await fetchAllFacilities();
  return all.find((f) => f.id === `nrw:${externalId}`) ?? null;
}
