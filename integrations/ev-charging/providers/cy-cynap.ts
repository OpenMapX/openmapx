import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { createPayloadStationMapper } from "./payload-station.js";
import { getEvChargingSourcePriority } from "./source-priority.js";

const STATION_ID_PREFIX = "cy-cynap:";

const reader = createStaticPoiReader<EvChargingStation>({
  sourceId: "cy-cynap",
  mapStatic: createPayloadStationMapper({
    sourceId: "cy-cynap",
    stationIdPrefix: STATION_ID_PREFIX,
  }),
  // [west, south, east, north] — Cyprus.
  coverage: [32, 34.5, 34.65, 35.75],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchCyCynapCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchCyCynapChargingDetail(
  itemId: string,
): Promise<EvChargingStation | null> {
  const poiId = itemId.startsWith(STATION_ID_PREFIX)
    ? itemId.slice(STATION_ID_PREFIX.length)
    : itemId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}

export const cyCynapSource: EvChargingSource = {
  id: "cy-cynap",
  priority: getEvChargingSourcePriority("cy-cynap"),
  search: searchCyCynapCharging,
  canFetchDetail: (itemId) => itemId.startsWith(STATION_ID_PREFIX),
  fetchDetail: fetchCyCynapChargingDetail,
};
