import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { createPayloadStationMapper } from "./payload-station.js";
import { getEvChargingSourcePriority } from "./source-priority.js";

const STATION_ID_PREFIX = "kr-datago:";

const reader = createStaticPoiReader<EvChargingStation>({
  sourceId: "kr-datago",
  mapStatic: createPayloadStationMapper({
    sourceId: "kr-datago",
    stationIdPrefix: STATION_ID_PREFIX,
  }),
  // [west, south, east, north] — South Korea including Jeju.
  coverage: [124.5, 33, 132, 38.7],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchKrDatagoCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchKrDatagoChargingDetail(
  itemId: string,
): Promise<EvChargingStation | null> {
  const poiId = itemId.startsWith(STATION_ID_PREFIX)
    ? itemId.slice(STATION_ID_PREFIX.length)
    : itemId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}

export const krDatagoSource: EvChargingSource = {
  id: "kr-datago",
  priority: getEvChargingSourcePriority("kr-datago"),
  search: searchKrDatagoCharging,
  canFetchDetail: (itemId) => itemId.startsWith(STATION_ID_PREFIX),
  fetchDetail: fetchKrDatagoChargingDetail,
};
