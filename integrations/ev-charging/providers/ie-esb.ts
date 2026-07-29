import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { createPayloadStationMapper } from "./payload-station.js";
import { getEvChargingSourcePriority } from "./source-priority.js";

const STATION_ID_PREFIX = "ie-esb:";

const reader = createStaticPoiReader<EvChargingStation>({
  sourceId: "ie-esb",
  mapStatic: createPayloadStationMapper({ sourceId: "ie-esb", stationIdPrefix: STATION_ID_PREFIX }),
  // [west, south, east, north] — Republic of Ireland + Northern Ireland.
  coverage: [-10.6, 51.3, -5.3, 55.5],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchIeEsbCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchIeEsbChargingDetail(itemId: string): Promise<EvChargingStation | null> {
  const poiId = itemId.startsWith(STATION_ID_PREFIX)
    ? itemId.slice(STATION_ID_PREFIX.length)
    : itemId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}

export const ieEsbSource: EvChargingSource = {
  id: "ie-esb",
  priority: getEvChargingSourcePriority("ie-esb"),
  search: searchIeEsbCharging,
  canFetchDetail: (itemId) => itemId.startsWith(STATION_ID_PREFIX),
  fetchDetail: fetchIeEsbChargingDetail,
};
