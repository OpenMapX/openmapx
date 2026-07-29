import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { createPayloadStationMapper } from "./payload-station.js";
import { getEvChargingSourcePriority } from "./source-priority.js";

const STATION_ID_PREFIX = "es-dgt:";

const reader = createStaticPoiReader<EvChargingStation>({
  sourceId: "es-dgt",
  mapStatic: createPayloadStationMapper({ sourceId: "es-dgt", stationIdPrefix: STATION_ID_PREFIX }),
  // [west, south, east, north] — Spain (peninsula, Balearic & Canary Islands).
  coverage: [-9.4, 35.9, 4.4, 43.8],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchEsDgtCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchEsDgtChargingDetail(itemId: string): Promise<EvChargingStation | null> {
  const poiId = itemId.startsWith(STATION_ID_PREFIX)
    ? itemId.slice(STATION_ID_PREFIX.length)
    : itemId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}

export const esDgtSource: EvChargingSource = {
  id: "es-dgt",
  priority: getEvChargingSourcePriority("es-dgt"),
  search: searchEsDgtCharging,
  canFetchDetail: (itemId) => itemId.startsWith(STATION_ID_PREFIX),
  fetchDetail: fetchEsDgtChargingDetail,
};
