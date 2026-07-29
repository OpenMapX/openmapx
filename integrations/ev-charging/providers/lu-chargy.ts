import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { createPayloadStationMapper } from "./payload-station.js";
import { getEvChargingSourcePriority } from "./source-priority.js";

const STATION_ID_PREFIX = "lu-chargy:";

const reader = createStaticPoiReader<EvChargingStation>({
  sourceId: "lu-chargy",
  mapStatic: createPayloadStationMapper({
    sourceId: "lu-chargy",
    stationIdPrefix: STATION_ID_PREFIX,
  }),
  // [west, south, east, north] — Luxembourg.
  coverage: [5.7, 49.4, 6.6, 50.2],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchLuChargyCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchLuChargyChargingDetail(
  itemId: string,
): Promise<EvChargingStation | null> {
  const poiId = itemId.startsWith(STATION_ID_PREFIX)
    ? itemId.slice(STATION_ID_PREFIX.length)
    : itemId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}

export const luChargySource: EvChargingSource = {
  id: "lu-chargy",
  priority: getEvChargingSourcePriority("lu-chargy"),
  search: searchLuChargyCharging,
  canFetchDetail: (itemId) => itemId.startsWith(STATION_ID_PREFIX),
  fetchDetail: fetchLuChargyChargingDetail,
};
