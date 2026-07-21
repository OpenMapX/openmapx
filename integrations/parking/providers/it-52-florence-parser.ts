import type { PoiBundledParseFn, PoiLiveState, PoiRow } from "@openmapx/poi-source-registry";

/**
 * Comune di Firenze ParkFreeSpot bundled parser.
 *
 * One bare JSON array per response. Each record carries name + lat/lng plus
 * a live `FreeSpot` count and `UpdateDate`. The pre-migration id was
 * `florence:${record.Id}`.
 */

interface FlorenceRawRecord {
  Id: string;
  Name: string;
  FreeSpot: string;
  UpdateDate: string;
  Latitude: string;
  Longitude: string;
}

export const parseIt52FlorenceBundled: PoiBundledParseFn = (buffer) => {
  const text = buffer.toString("utf-8");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { static: [], live: new Map<string, PoiLiveState>() };
  }
  if (!Array.isArray(data)) {
    return { static: [], live: new Map<string, PoiLiveState>() };
  }

  const staticRows: PoiRow[] = [];
  const live = new Map<string, PoiLiveState>();
  const fallbackAsOf = new Date().toISOString();

  for (const record of data as FlorenceRawRecord[]) {
    if (!record?.Id) continue;
    const lat = Number.parseFloat(record.Latitude);
    const lng = Number.parseFloat(record.Longitude);
    if (Number.isNaN(lat) || Number.isNaN(lng)) continue;

    staticRows.push({
      poiId: record.Id,
      lng,
      lat,
      payload: {
        coordinates: [lng, lat] as [number, number],
        name: record.Name || "Parking",
        parkingType: "garage",
        fee: "paid",
        access: "public",
      },
    });

    const freeSpaces = Number.parseInt(record.FreeSpot, 10);
    if (!Number.isNaN(freeSpaces) && freeSpaces >= 0) {
      live.set(record.Id, {
        asOf: record.UpdateDate || fallbackAsOf,
        freeSpaces,
      });
    }
  }

  return { static: staticRows, live };
};
