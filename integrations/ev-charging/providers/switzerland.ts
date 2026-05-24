import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { getEvChargingSourcePriority } from "./source-priority.js";
import { mapSwitzerlandPayload, mergeSwitzerlandLive } from "./switzerland-mapper.js";

const STATION_ID_PREFIX = "swiss-sfoe:";

const reader = createTwoTierPoiReader<EvChargingStation>({
  sourceId: "switzerland-ev",
  mapStatic: mapSwitzerlandPayload,
  mergeWithLive: mergeSwitzerlandLive,
  coverage: [5.9, 45.8, 10.6, 47.9],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchSwissSfoeCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchSwissSfoeChargingDetail(
  itemId: string,
): Promise<EvChargingStation | null> {
  const poiId = itemId.startsWith(STATION_ID_PREFIX)
    ? itemId.slice(STATION_ID_PREFIX.length)
    : itemId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}

export const swissSfoeSource: EvChargingSource = {
  id: "switzerland-ev",
  priority: getEvChargingSourcePriority("switzerland-ev"),
  search: searchSwissSfoeCharging,
  canFetchDetail: (itemId) => itemId.startsWith(STATION_ID_PREFIX),
  fetchDetail: fetchSwissSfoeChargingDetail,
};
