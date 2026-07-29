import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { createPayloadStationMapper } from "./payload-station.js";
import { getEvChargingSourcePriority } from "./source-priority.js";

const STATION_ID_PREFIX = "hk-epd:";

const reader = createStaticPoiReader<EvChargingStation>({
  sourceId: "hk-epd",
  mapStatic: createPayloadStationMapper({ sourceId: "hk-epd", stationIdPrefix: STATION_ID_PREFIX }),
  // [west, south, east, north] — Hong Kong.
  coverage: [113.8, 22.15, 114.5, 22.6],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchHkEpdCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchHkEpdChargingDetail(itemId: string): Promise<EvChargingStation | null> {
  const poiId = itemId.startsWith(STATION_ID_PREFIX)
    ? itemId.slice(STATION_ID_PREFIX.length)
    : itemId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}

export const hkEpdSource: EvChargingSource = {
  id: "hk-epd",
  priority: getEvChargingSourcePriority("hk-epd"),
  search: searchHkEpdCharging,
  canFetchDetail: (itemId) => itemId.startsWith(STATION_ID_PREFIX),
  fetchDetail: fetchHkEpdChargingDetail,
};
