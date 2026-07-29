import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { createPayloadStationMapper } from "./payload-station.js";
import { getEvChargingSourcePriority } from "./source-priority.js";

const STATION_ID_PREFIX = "be-flanders:";

const reader = createStaticPoiReader<EvChargingStation>({
  sourceId: "be-flanders",
  mapStatic: createPayloadStationMapper({
    sourceId: "be-flanders",
    stationIdPrefix: STATION_ID_PREFIX,
  }),
  // [west, south, east, north] — Flanders region.
  coverage: [2.5, 50.6, 5.95, 51.55],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchBeFlandersCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchBeFlandersChargingDetail(
  itemId: string,
): Promise<EvChargingStation | null> {
  const poiId = itemId.startsWith(STATION_ID_PREFIX)
    ? itemId.slice(STATION_ID_PREFIX.length)
    : itemId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}

export const beFlandersSource: EvChargingSource = {
  id: "be-flanders",
  priority: getEvChargingSourcePriority("be-flanders"),
  search: searchBeFlandersCharging,
  canFetchDetail: (itemId) => itemId.startsWith(STATION_ID_PREFIX),
  fetchDetail: fetchBeFlandersChargingDetail,
};
