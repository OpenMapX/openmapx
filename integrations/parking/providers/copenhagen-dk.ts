import type { BoundingBox } from "@openmapx/core";
import type { ParkingFacility, ParkingType } from "./types.js";

/**
 * Copenhagen (Denmark) open data parking client.
 *
 * Uses the Københavns Kommune WFS endpoint serving the p_hus dataset.
 * ~31 static parking garages across Copenhagen.
 * No real-time availability data.
 *
 * License: Open Data. No authentication required.
 */

interface CopenhagenFeatureProperties {
  id: number;
  vejkode: string | null;
  vejnavn: string | null;
  husnr: string | null;
  postdistrikt: string | null;
  antal_pladser: number | null;
  ejer_status: string | null;
  p_hus_type: string | null;
  type_beskrivelse: string | null;
  opret_dato: string | null;
  ret_dato: string | null;
  bemaerkning: string | null;
  ogc_fid: string | null;
}

interface CopenhagenGeoJsonResponse {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "Point"; coordinates: [number, number] };
    properties: CopenhagenFeatureProperties;
  }>;
}

const WFS_URL =
  "https://wfs-kbhkort.kk.dk/k101/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=k101:p_hus&outputFormat=json&SRSNAME=EPSG:4326";

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h — static data

const COVERAGE_BBOX = { south: 55.6, west: 12.45, north: 55.75, east: 12.68 };

let listCache: { facilities: ParkingFacility[]; fetchedAt: number } | null = null;

function overlapsCoverage(bbox: BoundingBox): boolean {
  return (
    bbox.south <= COVERAGE_BBOX.north &&
    bbox.north >= COVERAGE_BBOX.south &&
    bbox.west <= COVERAGE_BBOX.east &&
    bbox.east >= COVERAGE_BBOX.west
  );
}

function mapParkingType(typeBeskrivelse: string | null): ParkingType {
  if (!typeBeskrivelse) return "garage";
  const lower = typeBeskrivelse.toLowerCase();
  if (lower.includes("kælder") || lower.includes("kaelder")) return "underground";
  return "garage";
}

function featureToFacility(
  props: CopenhagenFeatureProperties,
  geometry?: [number, number],
): ParkingFacility | null {
  const lng = geometry?.[0];
  const lat = geometry?.[1];
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const capacity =
    props.antal_pladser != null && props.antal_pladser > 0 ? props.antal_pladser : undefined;

  let name = "Parking";
  if (props.bemaerkning) {
    name = props.bemaerkning;
  } else if (props.vejnavn) {
    name = props.husnr ? `${props.vejnavn} ${props.husnr}` : props.vejnavn;
  }

  let address: string | undefined;
  if (props.vejnavn) {
    const street = props.husnr ? `${props.vejnavn} ${props.husnr}` : props.vejnavn;
    address = props.postdistrikt ? `${street}, ${props.postdistrikt}` : street;
  }

  const access = props.ejer_status === "Privat" ? ("private" as const) : ("public" as const);

  return {
    id: `copenhagen:${props.id}`,
    name,
    coordinates: [lng, lat],
    sources: ["copenhagen-dk"],
    parkingType: mapParkingType(props.type_beskrivelse),
    capacity,
    hasRealtimeData: false,
    fee: "unknown",
    access,
    address,
  };
}

async function fetchAllFacilities(): Promise<ParkingFacility[]> {
  if (listCache && Date.now() - listCache.fetchedAt < CACHE_TTL) {
    return listCache.facilities;
  }

  const res = await fetch(WFS_URL, { signal: AbortSignal.timeout(30_000) });

  if (!res.ok) {
    if (listCache) return listCache.facilities;
    throw new Error(`Copenhagen parking WFS failed: ${res.status}`);
  }

  const data = (await res.json()) as CopenhagenGeoJsonResponse;

  const facilities: ParkingFacility[] = [];
  for (const feature of data.features) {
    const coords = feature.geometry?.coordinates as [number, number] | undefined;
    const facility = featureToFacility(feature.properties, coords);
    if (facility) facilities.push(facility);
  }

  listCache = { facilities, fetchedAt: Date.now() };
  return facilities;
}

export async function searchCopenhagenDk(bbox: BoundingBox): Promise<ParkingFacility[]> {
  if (!overlapsCoverage(bbox)) return [];

  const allFacilities = await fetchAllFacilities();
  return allFacilities.filter((f) => {
    const [lng, lat] = f.coordinates;
    return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  });
}

export async function fetchCopenhagenDkDetail(id: string): Promise<ParkingFacility | null> {
  const allFacilities = await fetchAllFacilities();
  return allFacilities.find((f) => f.id === `copenhagen:${id}`) ?? null;
}
