import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { createPayloadStationMapper } from "./payload-station.js";
import { getEvChargingSourcePriority } from "./source-priority.js";

const STATION_ID_PREFIX = "be-wallonia:";

const reader = createStaticPoiReader<EvChargingStation>({
  sourceId: "be-wallonia",
  mapStatic: createPayloadStationMapper({
    sourceId: "be-wallonia",
    stationIdPrefix: STATION_ID_PREFIX,
  }),
  // [west, south, east, north] — Wallonia.
  coverage: [2.8, 49.5, 6.4, 50.8],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchBeWalloniaCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchBeWalloniaChargingDetail(
  itemId: string,
): Promise<EvChargingStation | null> {
  const poiId = itemId.startsWith(STATION_ID_PREFIX)
    ? itemId.slice(STATION_ID_PREFIX.length)
    : itemId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}

export const beWalloniaSource: EvChargingSource = {
  id: "be-wallonia",
  priority: getEvChargingSourcePriority("be-wallonia"),
  search: searchBeWalloniaCharging,
  canFetchDetail: (itemId) => itemId.startsWith(STATION_ID_PREFIX),
  fetchDetail: fetchBeWalloniaChargingDetail,
};
