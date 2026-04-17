import type { BoundingBox } from "@openmapx/core";
import { fetchMobidromSites, filterByBbox, mapMobidromSite } from "./mobidrom-common.js";
import type { ParkingFacility } from "./types.js";

/**
 * GOLDBECK Parking Services GmbH feed via NRW Mobidrom.
 *
 * Static operator data for ~50 garages across Germany (currently NRW-heavy
 * but not geographically restricted). No real-time occupancy.
 */

const API_URL =
  "https://www.mobilitaetsdaten.nrw/api/systemadapter-mobilithek-exporter/parkplaetze-goldbeck-parking-services.json";
const CACHE_TTL = 6 * 60 * 60 * 1000;
const OPERATOR_NAME = "GOLDBECK Parking Services GmbH";

let cache: { facilities: ParkingFacility[]; fetchedAt: number } | null = null;

async function fetchAllFacilities(): Promise<ParkingFacility[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL) return cache.facilities;

  const sites = await fetchMobidromSites(API_URL, CACHE_TTL);
  const facilities: ParkingFacility[] = [];
  for (const site of sites) {
    const facility = mapMobidromSite(site, {
      idPrefix: "goldbeck",
      sourceId: "goldbeck",
      operatorName: OPERATOR_NAME,
    });
    if (facility) facilities.push(facility);
  }

  cache = { facilities, fetchedAt: Date.now() };
  return facilities;
}

export async function searchGoldbeck(bbox: BoundingBox): Promise<ParkingFacility[]> {
  const all = await fetchAllFacilities();
  return filterByBbox(all, bbox);
}

export async function fetchGoldbeckDetail(externalId: string): Promise<ParkingFacility | null> {
  const all = await fetchAllFacilities();
  return all.find((f) => f.id === `goldbeck:${externalId}`) ?? null;
}
