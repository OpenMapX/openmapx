import type { BoundingBox } from "@openmapx/core";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";

/**
 * Vienna (Austria) open data parking client.
 *
 * Uses the Stadt Wien WFS endpoint serving the GARAGENOGD dataset.
 * ~373 static parking garages and P+R facilities across Vienna.
 * No real-time availability data.
 *
 * License: CC BY 4.0. No authentication required.
 */

interface ViennaFeatureProperties {
  OBJECTID: number;
  GARAGE_ID: string;
  BETREIBER: string | null;
  BEZEICHNUNG: string | null;
  PLZ: number | null;
  ORT: string | null;
  ADRESSE: string | null;
  WEBLINK_BETR_DE: string | null;
  WEBLINK_BETR_EN: string | null;
  WEBLINK_WK_DE: string | null;
  WEBLINK_WK_EN: string | null;
  LONGITUDE: number | null;
  LATITUDE: number | null;
  PARK_AND_RIDE: string | null;
  BEHINDERTENPARKPL: string | null;
  SE_ANNO_CAD_DATA: unknown;
}

interface ViennaGeoJsonResponse {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "Point"; coordinates: [number, number] };
    properties: ViennaFeatureProperties;
  }>;
}

const WFS_URL =
  "https://data.wien.gv.at/daten/geo?service=WFS&request=GetFeature&version=1.1.0&typeName=ogdwien:GARAGENOGD&srsName=EPSG:4326&outputFormat=json";

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h — static data

const COVERAGE_BBOX = { south: 48.1, west: 16.18, north: 48.33, east: 16.58 };

let listCache: { facilities: ParkingFacility[]; fetchedAt: number } | null = null;

function overlapsCoverage(bbox: BoundingBox): boolean {
  return (
    bbox.south <= COVERAGE_BBOX.north &&
    bbox.north >= COVERAGE_BBOX.south &&
    bbox.west <= COVERAGE_BBOX.east &&
    bbox.east >= COVERAGE_BBOX.west
  );
}

function featureToFacility(
  props: ViennaFeatureProperties,
  geometry?: [number, number],
): ParkingFacility | null {
  const lng = geometry?.[0] ?? props.LONGITUDE;
  const lat = geometry?.[1] ?? props.LATITUDE;
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const isPnR = props.PARK_AND_RIDE === "Y";
  const hasDisabled = props.BEHINDERTENPARKPL === "Y";

  let address: string | undefined;
  if (props.ADRESSE) {
    address =
      props.ORT && props.PLZ ? `${props.ADRESSE}, ${props.PLZ} ${props.ORT}` : props.ADRESSE;
  }

  const parkingType: ParkingType = "garage";

  return {
    id: `vienna:${props.GARAGE_ID}`,
    name: props.BEZEICHNUNG || "Parking",
    coordinates: [lng, lat],
    sources: ["vienna-at"],
    parkingType,
    hasRealtimeData: false,
    disabledSpaces: hasDisabled ? 1 : undefined,
    fee: "unknown",
    access: "public",
    operator: props.BETREIBER ?? undefined,
    address,
    parkAndRide: isPnR || undefined,
    url: props.WEBLINK_BETR_DE ?? props.WEBLINK_WK_DE ?? undefined,
  };
}

async function fetchAllFacilities(): Promise<ParkingFacility[]> {
  if (listCache && Date.now() - listCache.fetchedAt < CACHE_TTL) {
    return listCache.facilities;
  }

  const res = await fetch(WFS_URL, { signal: AbortSignal.timeout(30_000) });

  if (!res.ok) {
    if (listCache) return listCache.facilities;
    throw new Error(`Vienna parking WFS failed: ${res.status}`);
  }

  const data = (await res.json()) as ViennaGeoJsonResponse;

  const facilities: ParkingFacility[] = [];
  for (const feature of data.features) {
    const coords = feature.geometry?.coordinates as [number, number] | undefined;
    const facility = featureToFacility(feature.properties, coords);
    if (facility) facilities.push(facility);
  }

  listCache = { facilities, fetchedAt: Date.now() };
  return facilities;
}

export async function searchViennaAt(bbox: BoundingBox): Promise<ParkingFacility[]> {
  if (!overlapsCoverage(bbox)) return [];

  const allFacilities = await fetchAllFacilities();
  return allFacilities.filter((f) => {
    const [lng, lat] = f.coordinates;
    return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  });
}

export async function fetchViennaAtDetail(id: string): Promise<ParkingFacility | null> {
  const allFacilities = await fetchAllFacilities();
  return allFacilities.find((f) => f.id === `vienna:${id}`) ?? null;
}
