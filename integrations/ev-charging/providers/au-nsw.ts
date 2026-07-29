import type { BoundingBox } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { createPayloadStationMapper } from "./payload-station.js";
import { getEvChargingSourcePriority } from "./source-priority.js";

const STATION_ID_PREFIX = "au-nsw-ev:";

const reader = createStaticPoiReader<EvChargingStation>({
  sourceId: "au-nsw-ev",
  mapStatic: createPayloadStationMapper({
    sourceId: "au-nsw-ev",
    stationIdPrefix: STATION_ID_PREFIX,
  }),
  // [west, south, east, north] — New South Wales.
  coverage: [140.9, -37.6, 153.7, -28],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchAuNswCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchAuNswChargingDetail(itemId: string): Promise<EvChargingStation | null> {
  const poiId = itemId.startsWith(STATION_ID_PREFIX)
    ? itemId.slice(STATION_ID_PREFIX.length)
    : itemId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}

export const auNswSource: EvChargingSource = {
  id: "au-nsw-ev",
  priority: getEvChargingSourcePriority("au-nsw-ev"),
  search: searchAuNswCharging,
  canFetchDetail: (itemId) => itemId.startsWith(STATION_ID_PREFIX),
  fetchDetail: fetchAuNswChargingDetail,
};
