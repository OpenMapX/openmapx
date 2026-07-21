import type { PoiRow } from "@openmapx/poi-source-registry";

/**
 * UTMC (Urban Traffic Management and Control) Tyne & Wear static feed.
 *
 * Per Tyne and Wear Open Data Services Platform API Specification
 * (Mott MacDonald, October 2019) section 5.4: the response is always a bare
 * JSON array of GbEngUtmcStaticCarPark records. We yield one PoiRow per record
 * whose first `definitions[]` element carries lat/lng.
 *
 * The payload intentionally omits dynamic-only fields (`freeSpaces`,
 * `state`, `occupancy`, `hasRealtimeData`, `dataUpdatedAt`,
 * `realtimeDataUpdatedAt`) — those land via the live parser + mergeGbEngUtmcLive.
 */

interface GbEngUtmcStaticCarPark {
  systemCodeNumber: string;
  definitions: Array<{
    shortDescription?: string;
    longDescription?: string;
    point?: {
      easting?: number;
      northing?: number;
      latitude?: number;
      longitude?: number;
    };
    lastUpdated?: string;
  }>;
  configurations: Array<{
    capacity?: number;
    configurationDate?: string;
  }>;
}

export function parseGbEngUtmcStatic(buffer: Buffer): PoiRow[] {
  const text = buffer.toString("utf-8");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  const out: PoiRow[] = [];
  for (const record of data as GbEngUtmcStaticCarPark[]) {
    if (!record?.systemCodeNumber) continue;
    const def = record.definitions?.[0];
    if (!def) continue;
    const lat = def.point?.latitude;
    const lng = def.point?.longitude;
    if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const cfg = record.configurations?.[0];
    const capacity = cfg?.capacity != null && cfg.capacity > 0 ? cfg.capacity : undefined;

    out.push({
      poiId: record.systemCodeNumber,
      lng,
      lat,
      payload: {
        // Coordinates duplicated in payload for mapper consumption — the reader
        // returns (poiId, payload) only; geom is used for SQL bbox filtering.
        coordinates: [lng, lat] as [number, number],
        name: def.shortDescription || `Car Park ${record.systemCodeNumber}`,
        capacity,
        address: def.longDescription ?? undefined,
        parkingType: "garage",
        fee: "unknown",
        staticDataUpdatedAt: def.lastUpdated,
      },
    });
  }
  return out;
}
