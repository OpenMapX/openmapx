import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { createPayloadStationMapper } from "./payload-station.js";
import { getEvChargingSourcePriority } from "./source-priority.js";

const STATION_ID_PREFIX = "de-bnetza:";

const reader = createStaticPoiReader<EvChargingStation>({
  sourceId: "de-bnetza",
  mapStatic: createPayloadStationMapper({
    sourceId: "de-bnetza",
    stationIdPrefix: STATION_ID_PREFIX,
  }),
  coverage: [5.5, 47.1, 15.6, 55.2],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchDeBnetzaCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchDeBnetzaChargingDetail(
  itemId: string,
): Promise<EvChargingStation | null> {
  const poiId = itemId.startsWith(STATION_ID_PREFIX)
    ? itemId.slice(STATION_ID_PREFIX.length)
    : itemId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}

export const deBnetzaSource: EvChargingSource = {
  id: "de-bnetza",
  priority: getEvChargingSourcePriority("de-bnetza"),
  search: searchDeBnetzaCharging,
  canFetchDetail: (itemId) => itemId.startsWith(STATION_ID_PREFIX),
  fetchDetail: fetchDeBnetzaChargingDetail,
};
