import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { createPayloadStationMapper } from "./payload-station.js";
import { getEvChargingSourcePriority } from "./source-priority.js";

const STATION_ID_PREFIX = "pl-eipa:";

const reader = createStaticPoiReader<EvChargingStation>({
  sourceId: "pl-eipa",
  mapStatic: createPayloadStationMapper({
    sourceId: "pl-eipa",
    stationIdPrefix: STATION_ID_PREFIX,
  }),
  // [west, south, east, north] — Poland.
  coverage: [14, 49, 24.2, 54.9],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchPlEipaCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchPlEipaChargingDetail(itemId: string): Promise<EvChargingStation | null> {
  const poiId = itemId.startsWith(STATION_ID_PREFIX)
    ? itemId.slice(STATION_ID_PREFIX.length)
    : itemId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}

export const plEipaSource: EvChargingSource = {
  id: "pl-eipa",
  priority: getEvChargingSourcePriority("pl-eipa"),
  search: searchPlEipaCharging,
  canFetchDetail: (itemId) => itemId.startsWith(STATION_ID_PREFIX),
  fetchDetail: fetchPlEipaChargingDetail,
};
