import type { PoiRow } from "@openmapx/poi-source-registry";

/**
 * Ajuntament de Barcelona parking-locations parser.
 *
 * Static-only bare JSON array (~556 records). `register_id` is the stable
 * per-facility key (pre-migration id was `barcelona:${register_id}`).
 *
 * One quirk worth keeping front of mind: `location_4326` ships coordinates as
 * `[lat, lng]`, not the GeoJSON-standard `[lng, lat]` — the pre-migration impl
 * accepted that, and we preserve it for equivalence.
 */

interface BarcelonaGeometry {
  type: string;
  geometries?: Array<{
    type: string;
    coordinates: [number, number];
  }>;
}

interface BarcelonaAddress {
  district_name?: string;
  neighborhood_name?: string;
  address_name?: string;
  start_street_number?: number | null;
  zip_code?: string;
  town?: string;
  location_4326?: BarcelonaGeometry;
}

interface BarcelonaRecord {
  register_id: number;
  name: string;
  status_name?: string;
  addresses?: BarcelonaAddress[];
  classifications_data?: Array<{
    name: string;
    full_path: string;
  }>;
  attribute_categories?: Array<{
    name: string;
    attributes: Array<{
      name: string;
      values: Array<{
        value: string;
      }>;
    }>;
  }>;
}

function extractCoordinates(address: BarcelonaAddress): [number, number] | null {
  const geom = address.location_4326;
  if (!geom?.geometries?.length) return null;

  const point = geom.geometries.find((g) => g.type === "Point");
  if (!point?.coordinates) return null;

  const [lat, lng] = point.coordinates;
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;

  return [lng, lat];
}

function buildAddress(addr: BarcelonaAddress): string | undefined {
  const parts: string[] = [];
  if (addr.address_name) {
    let street = addr.address_name;
    if (addr.start_street_number != null) {
      street += ` ${addr.start_street_number}`;
    }
    parts.push(street);
  }
  if (addr.zip_code && addr.town) {
    parts.push(`${addr.zip_code} ${addr.town}`);
  } else if (addr.town) {
    parts.push(addr.town);
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function extractPhone(record: BarcelonaRecord): string | undefined {
  if (!record.attribute_categories) return undefined;
  for (const cat of record.attribute_categories) {
    for (const attr of cat.attributes) {
      if (attr.name === "Tel." && attr.values?.length > 0) {
        return attr.values[0].value;
      }
    }
  }
  return undefined;
}

export function parseEsCtBarcelonaStatic(buffer: Buffer): PoiRow[] {
  const text = buffer.toString("utf-8");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  const out: PoiRow[] = [];
  for (const record of data as BarcelonaRecord[]) {
    if (!record?.register_id) continue;
    const address = record.addresses?.[0];
    if (!address) continue;
    const coords = extractCoordinates(address);
    if (!coords) continue;
    const [lng, lat] = coords;

    const phone = extractPhone(record);
    const streetAddress = buildAddress(address);
    const feeDescription = phone ? `Tel: ${phone}` : undefined;

    out.push({
      poiId: String(record.register_id),
      lng,
      lat,
      payload: {
        coordinates: [lng, lat] as [number, number],
        name: record.name || "Parking",
        parkingType: "garage",
        fee: "paid",
        feeDescription,
        access: "public",
        address: streetAddress,
        state: record.status_name === "Publicat" ? "open" : "unknown",
      },
    });
  }
  return out;
}
