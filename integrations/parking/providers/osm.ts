import type { BoundingBox } from "@openmapx/core";
import { overpassQuerySafe } from "@openmapx/core";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";

const PARKING_TAG_MAP: Record<string, ParkingType> = {
  "multi-storey": "garage",
  underground: "underground",
  surface: "surface",
  street_side: "on-street",
  lane: "on-street",
  rooftop: "garage",
};

function mapParkingTag(tag?: string): ParkingType {
  if (!tag) return "unknown";
  return PARKING_TAG_MAP[tag] ?? "unknown";
}

function parseFee(tags: Record<string, string>): "free" | "paid" | "unknown" {
  const fee = tags.fee;
  if (fee === "no") return "free";
  if (fee === "yes" || fee === "interval") return "paid";
  return "unknown";
}

function parseAccess(
  tags: Record<string, string>,
): "public" | "customers" | "private" | "permit" | undefined {
  const access = tags.access;
  if (access === "yes" || access === "public") return "public";
  if (access === "customers") return "customers";
  if (access === "private") return "private";
  if (access === "permit") return "permit";
  return undefined;
}

function parseCapacityTag(value?: string): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? undefined : n;
}

export interface OsmParkingElement {
  type: "node" | "way";
  id: number;
  lat: number;
  lon: number;
  center?: { lat: number; lon: number };
  tags: Record<string, string>;
}

function elementToFacility(el: OsmParkingElement): ParkingFacility | null {
  const lat = el.center?.lat ?? el.lat;
  const lon = el.center?.lon ?? el.lon;
  if (lat == null || lon == null) return null;

  const tags = el.tags ?? {};
  const capacity = parseCapacityTag(tags.capacity);

  return {
    id: `osm:${el.type}/${el.id}`,
    name: tags.name ?? "Parking",
    coordinates: [lon, lat],
    sources: ["osm"],
    parkingType: mapParkingTag(tags.parking),
    capacity,
    hasRealtimeData: false,
    disabledSpaces: parseCapacityTag(tags["capacity:disabled"]),
    chargingSpaces: parseCapacityTag(tags["capacity:charging"]),
    fee: parseFee(tags),
    access: parseAccess(tags),
    operator: tags.operator,
    openingHours: tags.opening_hours,
    parkAndRide: tags.park_ride
      ? tags.park_ride === "yes" || tags.park_ride === "bus" || tags.park_ride === "train"
      : undefined,
    state: "unknown",
    osmTags: tags,
  };
}

export async function searchOsmParking(bbox: BoundingBox): Promise<ParkingFacility[]> {
  const query = `[out:json][timeout:25];(node["amenity"="parking"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});way["amenity"="parking"](${bbox.south},${bbox.west},${bbox.north},${bbox.east}););out body center;`;

  const data = await overpassQuerySafe(query, null);
  if (!data) return [];

  const facilities: ParkingFacility[] = [];
  for (const el of data.elements) {
    if (el.type !== "node" && el.type !== "way") continue;
    const facility = elementToFacility(el as OsmParkingElement);
    if (facility) facilities.push(facility);
  }

  return facilities;
}

export async function fetchOsmParkingElement(
  elementType: string,
  elementId: number,
): Promise<ParkingFacility | null> {
  const query =
    elementType === "way"
      ? `[out:json][timeout:10];way(${elementId});out body center;`
      : `[out:json][timeout:10];node(${elementId});out body;`;

  const data = await overpassQuerySafe(query, null);
  if (!data || data.elements.length === 0) return null;

  const el = data.elements[0];
  return elementToFacility(el as OsmParkingElement);
}
