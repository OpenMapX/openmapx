import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapNlDotnlPayload, mergeNlDotnlLive } from "./nl-dotnl-mapper.js";
import { getEvChargingSourcePriority } from "./source-priority.js";

const STATION_ID_PREFIX = "nl-dotnl:";

const reader = createTwoTierPoiReader<EvChargingStation>({
  sourceId: "nl-dotnl",
  mapStatic: mapNlDotnlPayload,
  mergeWithLive: mergeNlDotnlLive,
  // [west, south, east, north]
  coverage: [3.2, 50.7, 7.3, 53.6],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchNlDotnlCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchNlDotnlChargingDetail(
  itemId: string,
): Promise<EvChargingStation | null> {
  const poiId = itemId.startsWith(STATION_ID_PREFIX)
    ? itemId.slice(STATION_ID_PREFIX.length)
    : itemId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}

export const nlDotnlSource: EvChargingSource = {
  id: "nl-dotnl",
  priority: getEvChargingSourcePriority("nl-dotnl"),
  search: searchNlDotnlCharging,
  canFetchDetail: (itemId) => itemId.startsWith(STATION_ID_PREFIX),
  fetchDetail: fetchNlDotnlChargingDetail,
};
