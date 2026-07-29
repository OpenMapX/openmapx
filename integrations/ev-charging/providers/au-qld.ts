import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { createPayloadStationMapper } from "./payload-station.js";
import { getEvChargingSourcePriority } from "./source-priority.js";

const STATION_ID_PREFIX = "au-qld-ev:";

const reader = createStaticPoiReader<EvChargingStation>({
  sourceId: "au-qld-ev",
  mapStatic: createPayloadStationMapper({
    sourceId: "au-qld-ev",
    stationIdPrefix: STATION_ID_PREFIX,
  }),
  // [west, south, east, north] — Queensland.
  coverage: [138, -29, 154, -9],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchAuQldCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchAuQldChargingDetail(itemId: string): Promise<EvChargingStation | null> {
  const poiId = itemId.startsWith(STATION_ID_PREFIX)
    ? itemId.slice(STATION_ID_PREFIX.length)
    : itemId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}

export const auQldSource: EvChargingSource = {
  id: "au-qld-ev",
  priority: getEvChargingSourcePriority("au-qld-ev"),
  search: searchAuQldCharging,
  canFetchDetail: (itemId) => itemId.startsWith(STATION_ID_PREFIX),
  fetchDetail: fetchAuQldChargingDetail,
};
