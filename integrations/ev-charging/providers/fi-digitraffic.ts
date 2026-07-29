import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { createPayloadStationMapper } from "./payload-station.js";
import { getEvChargingSourcePriority } from "./source-priority.js";

const STATION_ID_PREFIX = "fi-digitraffic:";

const reader = createStaticPoiReader<EvChargingStation>({
  sourceId: "fi-digitraffic",
  mapStatic: createPayloadStationMapper({
    sourceId: "fi-digitraffic",
    stationIdPrefix: STATION_ID_PREFIX,
  }),
  // [west, south, east, north] — Finland.
  coverage: [19, 59, 32, 70.5],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchFiDigitrafficCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchFiDigitrafficChargingDetail(
  itemId: string,
): Promise<EvChargingStation | null> {
  const poiId = itemId.startsWith(STATION_ID_PREFIX)
    ? itemId.slice(STATION_ID_PREFIX.length)
    : itemId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}

export const fiDigitrafficSource: EvChargingSource = {
  id: "fi-digitraffic",
  priority: getEvChargingSourcePriority("fi-digitraffic"),
  search: searchFiDigitrafficCharging,
  canFetchDetail: (itemId) => itemId.startsWith(STATION_ID_PREFIX),
  fetchDetail: fetchFiDigitrafficChargingDetail,
};
