import type { BoundingBox } from "@openmapx/core";
import { fetchMobidromSites, filterByBbox, mapMobidromSite } from "./mobidrom-common.js";
import type { ParkingFacility } from "./types.js";

/**
 * APCOA Deutschland GmbH parking facilities via NRW Mobidrom.
 *
 * Operator feed covering APCOA-managed garages. Currently published as an
 * empty array but the schema matches the Mobidrom Parking Light profile.
 * No geographic restriction is applied since APCOA operates across Europe.
 */

const API_URL =
  "https://www.mobilitaetsdaten.nrw/api/systemadapter-mobilithek-exporter/parking-apcoa.json";
const CACHE_TTL = 6 * 60 * 60 * 1000;
const OPERATOR_NAME = "APCOA Deutschland GmbH";

let cache: { facilities: ParkingFacility[]; fetchedAt: number } | null = null;

async function fetchAllFacilities(): Promise<ParkingFacility[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL) return cache.facilities;

  const sites = await fetchMobidromSites(API_URL, CACHE_TTL);
  const facilities: ParkingFacility[] = [];
  for (const site of sites) {
    const facility = mapMobidromSite(site, {
      idPrefix: "apcoa",
      sourceId: "apcoa",
      operatorName: OPERATOR_NAME,
    });
    if (facility) facilities.push(facility);
  }

  cache = { facilities, fetchedAt: Date.now() };
  return facilities;
}

export async function searchApcoa(bbox: BoundingBox): Promise<ParkingFacility[]> {
  const all = await fetchAllFacilities();
  return filterByBbox(all, bbox);
}

export async function fetchApcoaDetail(externalId: string): Promise<ParkingFacility | null> {
  const all = await fetchAllFacilities();
  return all.find((f) => f.id === `apcoa:${externalId}`) ?? null;
}
