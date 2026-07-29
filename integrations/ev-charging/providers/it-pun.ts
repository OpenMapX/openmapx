import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { createPayloadStationMapper } from "./payload-station.js";
import { getEvChargingSourcePriority } from "./source-priority.js";

const STATION_ID_PREFIX = "it-pun:";

const reader = createStaticPoiReader<EvChargingStation>({
  sourceId: "it-pun",
  mapStatic: createPayloadStationMapper({
    sourceId: "it-pun",
    stationIdPrefix: STATION_ID_PREFIX,
  }),
  // [west, south, east, north] — Italy.
  coverage: [6.6, 35.4, 18.6, 47.1],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchItPunCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchItPunChargingDetail(itemId: string): Promise<EvChargingStation | null> {
  const poiId = itemId.startsWith(STATION_ID_PREFIX)
    ? itemId.slice(STATION_ID_PREFIX.length)
    : itemId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}

export const itPunSource: EvChargingSource = {
  id: "it-pun",
  priority: getEvChargingSourcePriority("it-pun"),
  search: searchItPunCharging,
  canFetchDetail: (itemId) => itemId.startsWith(STATION_ID_PREFIX),
  fetchDetail: fetchItPunChargingDetail,
};
