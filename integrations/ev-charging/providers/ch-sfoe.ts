import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapChSfoePayload, mergeChSfoeLive } from "./ch-sfoe-mapper.js";
import { getEvChargingSourcePriority } from "./source-priority.js";

const STATION_ID_PREFIX = "ch-sfoe:";

const reader = createTwoTierPoiReader<EvChargingStation>({
  sourceId: "ch-sfoe",
  mapStatic: mapChSfoePayload,
  mergeWithLive: mergeChSfoeLive,
  coverage: [5.9, 45.8, 10.6, 47.9],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchChSfoeCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchChSfoeChargingDetail(itemId: string): Promise<EvChargingStation | null> {
  const poiId = itemId.startsWith(STATION_ID_PREFIX)
    ? itemId.slice(STATION_ID_PREFIX.length)
    : itemId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}

export const chSfoeSource: EvChargingSource = {
  id: "ch-sfoe",
  priority: getEvChargingSourcePriority("ch-sfoe"),
  search: searchChSfoeCharging,
  canFetchDetail: (itemId) => itemId.startsWith(STATION_ID_PREFIX),
  fetchDetail: fetchChSfoeChargingDetail,
};
