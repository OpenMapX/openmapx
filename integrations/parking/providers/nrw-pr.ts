import type { BoundingBox } from "@openmapx/core";
import {
  bboxOverlaps,
  fetchMobidromSites,
  filterByBbox,
  mapMobidromSite,
} from "./mobidrom-common.js";
import type { ParkingFacility } from "./types.js";

/**
 * NRW Mobidrom bundled Park+Ride feed.
 *
 * Aggregate of P+R facilities across VRR, Bielefeld, Bonn, Köln, Münster, and
 * Oberhausen (~306 sites). Same DATEX II Parking Light schema as the main
 * Mobidrom feeds, but every record is authoritatively a Park+Ride facility,
 * so the mapper forces `parkAndRide: true` regardless of name heuristics.
 */

const API_URL =
  "https://www.mobilitaetsdaten.nrw/api/systemadapter-mobilithek-exporter/gebndelte-daten-parkride-nrw.json";
const CACHE_TTL = 30 * 60 * 1000;

const COVERAGE_BBOX: BoundingBox = { south: 50.32, west: 5.87, north: 52.53, east: 9.46 };

let cache: { facilities: ParkingFacility[]; fetchedAt: number } | null = null;

async function fetchAllFacilities(): Promise<ParkingFacility[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL) return cache.facilities;

  const sites = await fetchMobidromSites(API_URL, CACHE_TTL);
  const facilities: ParkingFacility[] = [];
  for (const site of sites) {
    const facility = mapMobidromSite(site, {
      idPrefix: "nrw-pr",
      sourceId: "nrw-mobidrom-pr",
      forceParkAndRide: true,
    });
    if (facility) facilities.push(facility);
  }

  cache = { facilities, fetchedAt: Date.now() };
  return facilities;
}

export async function searchNrwPr(bbox: BoundingBox): Promise<ParkingFacility[]> {
  if (!bboxOverlaps(bbox, COVERAGE_BBOX)) return [];
  const all = await fetchAllFacilities();
  return filterByBbox(all, bbox);
}

export async function fetchNrwPrDetail(externalId: string): Promise<ParkingFacility | null> {
  const all = await fetchAllFacilities();
  return all.find((f) => f.id === `nrw-pr:${externalId}`) ?? null;
}
