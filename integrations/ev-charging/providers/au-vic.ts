import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { createPayloadStationMapper } from "./payload-station.js";
import { getEvChargingSourcePriority } from "./source-priority.js";

const STATION_ID_PREFIX = "au-vic-ev:";

const reader = createStaticPoiReader<EvChargingStation>({
  sourceId: "au-vic-ev",
  mapStatic: createPayloadStationMapper({
    sourceId: "au-vic-ev",
    stationIdPrefix: STATION_ID_PREFIX,
  }),
  // [west, south, east, north] — Victoria.
  coverage: [140.9, -39.2, 150, -33.9],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchAuVicCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchAuVicChargingDetail(itemId: string): Promise<EvChargingStation | null> {
  const poiId = itemId.startsWith(STATION_ID_PREFIX)
    ? itemId.slice(STATION_ID_PREFIX.length)
    : itemId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}

export const auVicSource: EvChargingSource = {
  id: "au-vic-ev",
  priority: getEvChargingSourcePriority("au-vic-ev"),
  search: searchAuVicCharging,
  canFetchDetail: (itemId) => itemId.startsWith(STATION_ID_PREFIX),
  fetchDetail: fetchAuVicChargingDetail,
};
