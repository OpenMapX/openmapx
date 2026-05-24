import type { PoiRow } from "@openmapx/poi-source-registry";

/**
 * Madrid (Ayuntamiento de Madrid) JSON-LD parking catalog parser.
 *
 * Static-only feed (~100 entries: public, resident, P+R garages). The raw
 * JSON ships with malformed longitudes that look like "--3.65..." — we
 * strip the leading "-" before JSON.parse, which is the same trick the
 * pre-migration in-memory client used.
 */

interface MadridAddress {
  locality?: string;
  "postal-code"?: string;
  "street-address"?: string;
}

interface MadridOrganization {
  "organization-desc"?: string;
  "organization-name"?: string;
  schedule?: string;
}

interface MadridGraphEntry {
  "@id": string;
  "@type": string;
  id: string;
  title: string;
  relation?: string;
  address?: MadridAddress;
  location?: { latitude: number; longitude: number | string };
  organization?: MadridOrganization;
}

interface MadridApiResponse {
  "@graph": MadridGraphEntry[];
}

function fixLongitude(raw: number | string): number {
  const str = String(raw);
  const fixed = str.startsWith("--") ? str.slice(1) : str;
  return Number(fixed);
}

function parseCapacity(desc: string | undefined): number | undefined {
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

function parseDisabledSpaces(desc: string | undefined): number | undefined {
  if (!desc) return undefined;
  const match = desc.match(/(\d+)\s*minusv[áa]lidos/i);
  return match ? Number(match[1]) : undefined;
}

function inferParkingType(title: string): "underground" | "surface" | "garage" {
  const lower = title.toLowerCase();
  if (lower.includes("subterr")) return "underground";
  if (lower.includes("superficie")) return "surface";
  return "garage";
}

function parseOpeningHours(org: MadridOrganization | undefined): string | undefined {
  if (!org) return undefined;
  if (org.schedule && org.schedule.trim().length > 0) return org.schedule.trim();
  const desc = org["organization-desc"] ?? "";
  if (/abierto\s+24\s*horas/i.test(desc)) return "Abierto 24 horas";
  return undefined;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

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

export function parseMadridEsStatic(buffer: Buffer): PoiRow[] {
  const raw = buffer.toString("utf-8");
  // The JSON contains double-negative longitudes like "--3.65..." which
  // are invalid JSON numbers; sanitise BEFORE JSON.parse to avoid throws.
  const sanitized = raw.replace(/:\s*--(\d)/g, ": -$1");
  let data: MadridApiResponse;
  try {
    data = JSON.parse(sanitized) as MadridApiResponse;
  } catch {
    return [];
  }
  if (!Array.isArray(data?.["@graph"])) return [];

  const out: PoiRow[] = [];
  for (const entry of data["@graph"]) {
    const lat = entry.location?.latitude;
    const rawLng = entry.location?.longitude;
    if (lat == null || rawLng == null) continue;
    const lng = fixLongitude(rawLng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) continue;

    const title = entry.title || entry.organization?.["organization-name"] || "Parking";
    const desc = entry.organization?.["organization-desc"];
    const lowerTitle = title.toLowerCase();
    const isParkAndRide = lowerTitle.includes("disuasorio") || lowerTitle.includes("p+r");

    out.push({
      poiId: entry.id,
      lng,
      lat,
      payload: {
        coordinates: [lng, lat] as [number, number],
        name: title,
        parkingType: inferParkingType(title),
        capacity: parseCapacity(desc),
        disabledSpaces: parseDisabledSpaces(desc),
        fee: "paid",
        address: formatAddress(entry.address),
        openingHours: parseOpeningHours(entry.organization),
        url: entry.relation ?? undefined,
        parkAndRide: isParkAndRide || undefined,
      },
    });
  }
  return out;
}
