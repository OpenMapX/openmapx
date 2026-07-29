import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { createPayloadStationMapper } from "./payload-station.js";
import { getEvChargingSourcePriority } from "./source-priority.js";

const STATION_ID_PREFIX = "nz-evroam:";

const reader = createStaticPoiReader<EvChargingStation>({
  sourceId: "nz-evroam",
  mapStatic: createPayloadStationMapper({
    sourceId: "nz-evroam",
    stationIdPrefix: STATION_ID_PREFIX,
  }),
  // [west, south, east, north] — New Zealand.
  coverage: [166, -47.5, 179, -34],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchNzEvroamCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchNzEvroamChargingDetail(
  itemId: string,
): Promise<EvChargingStation | null> {
  const poiId = itemId.startsWith(STATION_ID_PREFIX)
    ? itemId.slice(STATION_ID_PREFIX.length)
    : itemId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}

export const nzEvroamSource: EvChargingSource = {
  id: "nz-evroam",
  priority: getEvChargingSourcePriority("nz-evroam"),
  search: searchNzEvroamCharging,
  canFetchDetail: (itemId) => itemId.startsWith(STATION_ID_PREFIX),
  fetchDetail: fetchNzEvroamChargingDetail,
};
