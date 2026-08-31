import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParkingFacility, ParkingType } from "@openmapx/mobility-core/parking";
import { mapEsMdMadridPayload } from "../es-md-madrid-mapper.js";
import { parseEsMdMadridStatic } from "../es-md-madrid-parser.js";
import { parkingEquivalenceContract } from "./support/parking-equivalence-contract.js";

/**
 * Pre-migration reference, lifted verbatim from the prior madrid-es.ts.
 * Source id is `es-md-madrid` (prefix `es-md-madrid:`).
 */

interface EsMdMadridAddress {
  locality?: string;
  "postal-code"?: string;
  "street-address"?: string;
}
interface EsMdMadridOrganization {
  "organization-desc"?: string;
  "organization-name"?: string;
  schedule?: string;
}
interface EsMdMadridGraphEntry {
  "@id": string;
  "@type": string;
  id: string;
  title: string;
  relation?: string;
  address?: EsMdMadridAddress;
  location?: { latitude: number; longitude: number | string };
  organization?: EsMdMadridOrganization;
}
interface EsMdMadridApiResponse {
  "@graph": EsMdMadridGraphEntry[];
}

function refFixLongitude(raw: number | string): number {
  const str = String(raw);
  const fixed = str.startsWith("--") ? str.slice(1) : str;
  return Number(fixed);
}

function refParseCapacity(desc: string | undefined): number | undefined {
  if (!desc) return undefined;
  const simpleMatch = desc.match(/Plazas:\s*(\d+)/i);
  if (simpleMatch) {
    const mixedMatch = desc.match(/Plazas:\s*(\d+)\s*p[úu]blicas\s+y\s+(\d+)\s*residentes/i);
    if (mixedMatch) return Number(mixedMatch[1]) + Number(mixedMatch[2]);
    return Number(simpleMatch[1]);
  }
  const autoMatch = desc.match(/autom[óo]viles\s*[:\s]*(\d+)/i);
  if (autoMatch) return Number(autoMatch[1]);
  return undefined;
}

function refParseDisabledSpaces(desc: string | undefined): number | undefined {
  if (!desc) return undefined;
  const match = desc.match(/(\d+)\s*minusv[áa]lidos/i);
  return match ? Number(match[1]) : undefined;
}

function refInferParkingType(title: string): ParkingType {
  const lower = title.toLowerCase();
  if (lower.includes("subterr")) return "underground";
  if (lower.includes("superficie")) return "surface";
  return "garage";
}

function refParseOpeningHours(org: EsMdMadridOrganization | undefined): string | undefined {
  if (!org) return undefined;
  if (org.schedule && org.schedule.trim().length > 0) return org.schedule.trim();
  const desc = org["organization-desc"] ?? "";
  if (/abierto\s+24\s*horas/i.test(desc)) return "Abierto 24 horas";
  return undefined;
}

function refTitleCase(s: string): string {
  return s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

function refFormatAddress(addr: EsMdMadridAddress | undefined): string | undefined {
  if (!addr) return undefined;
  const parts: string[] = [];
  if (addr["street-address"]) parts.push(refTitleCase(addr["street-address"]));
  if (addr["postal-code"] || addr.locality) {
    const zip = addr["postal-code"] ?? "";
    const city = addr.locality ? refTitleCase(addr.locality) : "";
    parts.push([zip, city].filter(Boolean).join(" "));
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function refEntryToFacility(entry: EsMdMadridGraphEntry): ParkingFacility | null {
  const lat = entry.location?.latitude;
  const rawLng = entry.location?.longitude;
  if (lat == null || rawLng == null) return null;
  const lng = refFixLongitude(rawLng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const title = entry.title || entry.organization?.["organization-name"] || "Parking";
  const desc = entry.organization?.["organization-desc"];
  const lowerTitle = title.toLowerCase();
  const isParkAndRide = lowerTitle.includes("disuasorio") || lowerTitle.includes("p+r");

  return {
    id: `es-md-madrid:${entry.id}`,
    name: title,
    coordinates: [lng, lat],
    sources: ["es-md-madrid"],
    parkingType: refInferParkingType(title),
    capacity: refParseCapacity(desc),
    hasRealtimeData: false,
    disabledSpaces: refParseDisabledSpaces(desc),
    fee: "paid",
    address: refFormatAddress(entry.address),
    openingHours: refParseOpeningHours(entry.organization),
    url: entry.relation ?? undefined,
    parkAndRide: isParkAndRide || undefined,
  };
}

const FIXTURE = readFileSync(join(__dirname, "fixtures", "madrid-es-sample.json"));

function runReference(): ParkingFacility[] {
  const sanitised = FIXTURE.toString("utf-8").replace(/:\s*--(\d)/g, ": -$1");
  const data = JSON.parse(sanitised) as EsMdMadridApiResponse;
  const out: ParkingFacility[] = [];
  for (const entry of data["@graph"]) {
    const facility = refEntryToFacility(entry);
    if (facility) out.push(facility);
  }
  return out;
}

function runMigrated(): ParkingFacility[] {
  return parseEsMdMadridStatic(FIXTURE).map((row) => mapEsMdMadridPayload(row.poiId, row.payload));
}

parkingEquivalenceContract({
  name: "Madrid",
  reference: runReference,
  migrated: runMigrated,
  fields: [
    "id",
    "name",
    "coordinates",
    "sources",
    "parkingType",
    "capacity",
    "hasRealtimeData",
    "disabledSpaces",
    "fee",
    "address",
    "openingHours",
    "url",
    "parkAndRide",
  ],
});
