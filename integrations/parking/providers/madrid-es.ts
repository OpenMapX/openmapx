import type { BoundingBox } from "@openmapx/core";
import type { ParkingFacility, ParkingType } from "./types.js";

/**
 * Madrid open-data parking client (Ayuntamiento de Madrid).
 *
 * Static facility list (~100 entries) covering public, resident, and
 * park-and-ride garages across Madrid. JSON-LD format with @graph array.
 * No real-time availability data.
 *
 * Known data bug: some longitude values contain a double negative ("--3.65...")
 * which we strip during parsing.
 *
 * License: Open Data. No authentication required.
 */

const API_URL = "https://datos.madrid.es/egob/catalogo/202625-0-aparcamientos-publicos.json";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h — static data

const COVERAGE_BBOX = { south: 40.3, west: -3.85, north: 40.55, east: -3.55 };

let listCache: { facilities: ParkingFacility[]; fetchedAt: number } | null = null;

interface MadridAddress {
  district?: { "@id": string };
  area?: { "@id": string };
  locality?: string;
  "postal-code"?: string;
  "street-address"?: string;
}

interface MadridLocation {
  latitude: number;
  longitude: number | string;
}

interface MadridOrganization {
  "organization-desc"?: string;
  "organization-name"?: string;
  accesibility?: string;
  schedule?: string;
  services?: string;
}

interface MadridGraphEntry {
  "@id": string;
  "@type": string;
  id: string;
  title: string;
  relation?: string;
  address?: MadridAddress;
  location?: MadridLocation;
  organization?: MadridOrganization;
}

interface MadridApiResponse {
  "@context": Record<string, unknown>;
  "@graph": MadridGraphEntry[];
}

function overlapsCoverage(bbox: BoundingBox): boolean {
  return (
    bbox.south <= COVERAGE_BBOX.north &&
    bbox.north >= COVERAGE_BBOX.south &&
    bbox.west <= COVERAGE_BBOX.east &&
    bbox.east >= COVERAGE_BBOX.west
  );
}

/**
 * Fix the double-negative longitude bug in the Madrid dataset.
 * Values like "--3.65138..." become "-3.65138...".
 */
function fixLongitude(raw: number | string): number {
  const str = String(raw);
  const fixed = str.startsWith("--") ? str.slice(1) : str;
  return Number(fixed);
}

/**
 * Try to extract a total capacity number from the organization-desc field.
 * Patterns seen: "Plazas: 463", "Plazas: automóviles 344", "Plazas: 104 públicas y 550 residentes"
 */
function parseCapacity(desc: string | undefined): number | undefined {
  if (!desc) return undefined;

  // "Plazas: <number>" at the start
  const simpleMatch = desc.match(/Plazas:\s*(\d+)/i);
  if (simpleMatch) {
    // Check for "X públicas y Y residentes" pattern — sum both
    const mixedMatch = desc.match(/Plazas:\s*(\d+)\s*p[úu]blicas\s+y\s+(\d+)\s*residentes/i);
    if (mixedMatch) {
      return Number(mixedMatch[1]) + Number(mixedMatch[2]);
    }
    return Number(simpleMatch[1]);
  }

  // "automóviles NNN" pattern
  const autoMatch = desc.match(/autom[óo]viles\s*[:\s]*(\d+)/i);
  if (autoMatch) return Number(autoMatch[1]);

  return undefined;
}

/**
 * Try to extract disabled parking spaces count from description.
 * Pattern: "17 minusválidos"
 */
function parseDisabledSpaces(desc: string | undefined): number | undefined {
  if (!desc) return undefined;
  const match = desc.match(/(\d+)\s*minusv[áa]lidos/i);
  return match ? Number(match[1]) : undefined;
}

/**
 * Infer parking type from the title and @type URI.
 */
function inferParkingType(title: string, _typeUri: string): ParkingType {
  const lower = title.toLowerCase();
  if (lower.includes("subterr")) return "underground";
  if (lower.includes("superficie")) return "surface";
  return "garage";
}

/**
 * Build the opening hours string from schedule + organization-desc fallback.
 */
function parseOpeningHours(org: MadridOrganization | undefined): string | undefined {
  if (!org) return undefined;

  // Prefer the dedicated schedule field
  if (org.schedule && org.schedule.trim().length > 0) {
    return org.schedule.trim();
  }

  // Fall back to "Abierto 24 horas" if mentioned in the description
  const desc = org["organization-desc"] ?? "";
  if (/abierto\s+24\s*horas/i.test(desc)) {
    return "Abierto 24 horas";
  }

  return undefined;
}

/**
 * Format the street address from the address sub-object.
 */
function formatAddress(addr: MadridAddress | undefined): string | undefined {
  if (!addr) return undefined;
  const parts: string[] = [];
  if (addr["street-address"]) parts.push(titleCase(addr["street-address"]));
  if (addr["postal-code"] || addr.locality) {
    const zip = addr["postal-code"] ?? "";
    const city = addr.locality ? titleCase(addr.locality) : "";
    parts.push([zip, city].filter(Boolean).join(" "));
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

function entryToFacility(entry: MadridGraphEntry): ParkingFacility | null {
  const lat = entry.location?.latitude;
  const rawLng = entry.location?.longitude;
  if (lat == null || rawLng == null) return null;

  const lng = fixLongitude(rawLng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const title = entry.title || entry.organization?.["organization-name"] || "Parking";
  const desc = entry.organization?.["organization-desc"];
  const lowerTitle = title.toLowerCase();

  const isParkAndRide = lowerTitle.includes("disuasorio") || lowerTitle.includes("p+r");

  return {
    id: `madrid:${entry.id}`,
    name: title,
    coordinates: [lng, lat],
    sources: ["madrid-es"],
    parkingType: inferParkingType(title, entry["@type"]),
    capacity: parseCapacity(desc),
    hasRealtimeData: false,
    disabledSpaces: parseDisabledSpaces(desc),
    fee: "paid",
    address: formatAddress(entry.address),
    openingHours: parseOpeningHours(entry.organization),
    url: entry.relation ?? undefined,
    parkAndRide: isParkAndRide || undefined,
  };
}

async function fetchAllFacilities(): Promise<ParkingFacility[]> {
  if (listCache && Date.now() - listCache.fetchedAt < CACHE_TTL) {
    return listCache.facilities;
  }

  const res = await fetch(API_URL, { signal: AbortSignal.timeout(30_000) });

  if (!res.ok) {
    if (listCache) return listCache.facilities;
    throw new Error(`Madrid parking API failed: ${res.status}`);
  }

  // The JSON contains double-negative longitudes like "--3.65..."
  // which are invalid JSON numbers. We fix this in the raw text
  // before parsing to avoid JSON.parse errors.
  const text = await res.text();
  const sanitized = text.replace(/:\s*--(\d)/g, ": -$1");
  const data = JSON.parse(sanitized) as MadridApiResponse;

  const facilities: ParkingFacility[] = [];
  for (const entry of data["@graph"]) {
    const facility = entryToFacility(entry);
    if (facility) facilities.push(facility);
  }

  listCache = { facilities, fetchedAt: Date.now() };
  return facilities;
}

export async function searchMadridEs(bbox: BoundingBox): Promise<ParkingFacility[]> {
  if (!overlapsCoverage(bbox)) return [];

  const allFacilities = await fetchAllFacilities();
  return allFacilities.filter((f) => {
    const [lng, lat] = f.coordinates;
    return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  });
}

export async function fetchMadridEsDetail(id: string): Promise<ParkingFacility | null> {
  const allFacilities = await fetchAllFacilities();
  return allFacilities.find((f) => f.id === `madrid:${id}`) ?? null;
}
