import type { PoiRow } from "@openmapx/poi-source-registry";

/**
 * Brussels OpenDataSoft v2.1 catalog parser.
 *
 * Static-only feed (no live availability). License: CC0 1.0, no auth required.
 * One PoiRow per record whose geo_point_2d carries lat/lng; the rest of the
 * record lands in payload for mapBeBruBrusselsPayload to project into ParkingFacility.
 */

interface BrusselsRecord {
  name_fr: string | null;
  name_nl: string | null;
  adressee: string | null;
  adres_: string | null;
  geo_point_2d: { lon: number; lat: number } | null;
  operator_fr: string | null;
  capacity: number | null;
  disabledcapacity: number | null;
  floors: number | null;
  maxheight: number | null;
}

interface BrusselsResponse {
  results: BrusselsRecord[];
}

function parseMaxHeight(value: number | null): number | undefined {
  if (value == null || value <= 0) return undefined;
  // Values < 10 are meters, >= 10 are already centimeters.
  return value < 10 ? Math.round(value * 100) : Math.round(value);
}

export function parseBeBruBrusselsStatic(buffer: Buffer): PoiRow[] {
  const text = buffer.toString("utf-8");
  let data: BrusselsResponse;
  try {
    data = JSON.parse(text) as BrusselsResponse;
  } catch {
    return [];
  }
  if (!Array.isArray(data?.results)) return [];

  const out: PoiRow[] = [];
  for (const record of data.results) {
    const lng = record.geo_point_2d?.lon;
    const lat = record.geo_point_2d?.lat;
    if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) continue;

    const name = record.name_fr || record.name_nl || "Parking";
    const capacity = record.capacity != null && record.capacity > 0 ? record.capacity : undefined;
    const disabledSpaces =
      record.disabledcapacity != null && record.disabledcapacity > 0
        ? record.disabledcapacity
        : undefined;
    const maxHeight = parseMaxHeight(record.maxheight);

    out.push({
      // poiId mirrors the pre-migration `id` (name-based) so the migrated
      // station id `brussels:<name>` is byte-identical.
      poiId: name,
      lng,
      lat,
      payload: {
        coordinates: [lng, lat] as [number, number],
        name,
        capacity,
        disabledSpaces,
        maxHeight,
        parkingType: "garage",
        fee: "unknown",
        operator: record.operator_fr ?? undefined,
        address: record.adressee ?? undefined,
      },
    });
  }
  return out;
}
