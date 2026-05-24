import type { PoiLiveParseFn, PoiLiveState } from "@openmapx/poi-source-registry";

/**
 * Singapore HDB carpark availability live parser.
 *
 * One fetch returns the data.gov.sg carpark-availability response — a single
 * snapshot of ~1,994 carparks. Each carpark may have multiple lot types
 * (C=car, Y=motorcycle, H=heavy vehicle); we keep only the car lots and sum
 * them, matching the pre-migration provider.
 *
 * The live state carries `capacity` and `freeSpaces` together so the mapper
 * can decide whether to override the static-fallback capacity when authoritative
 * live capacity is present.
 */

interface AvailabilityCarparkInfo {
  total_lots: string;
  lot_type: string;
  lots_available: string;
}

interface AvailabilityCarparkData {
  carpark_number: string;
  update_datetime: string;
  carpark_info: AvailabilityCarparkInfo[];
}

interface AvailabilityResponse {
  items?: Array<{
    timestamp: string;
    carpark_data: AvailabilityCarparkData[];
  }>;
}

export const parseSingaporeLive: PoiLiveParseFn = (buffer) => {
  const text = buffer.toString("utf-8");
  let data: AvailabilityResponse;
  try {
    data = JSON.parse(text) as AvailabilityResponse;
  } catch {
    return new Map<string, PoiLiveState>();
  }
  const items = data?.items;
  if (!Array.isArray(items) || items.length === 0) return new Map<string, PoiLiveState>();

  const fallbackAsOf = new Date().toISOString();
  const out = new Map<string, PoiLiveState>();

  for (const cp of items[0].carpark_data ?? []) {
    if (!cp?.carpark_number) continue;
    let totalCar = 0;
    let freeCar = 0;
    for (const lot of cp.carpark_info ?? []) {
      if (lot.lot_type === "C") {
        totalCar += Number.parseInt(lot.total_lots, 10) || 0;
        freeCar += Number.parseInt(lot.lots_available, 10) || 0;
      }
    }
    if (totalCar <= 0) continue;
    out.set(cp.carpark_number, {
      asOf: cp.update_datetime || fallbackAsOf,
      capacity: totalCar,
      freeSpaces: freeCar,
    });
  }
  return out;
};
