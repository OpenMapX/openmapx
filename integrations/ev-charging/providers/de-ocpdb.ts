import type { BoundingBox } from "@openmapx/core";
import { createTwoTierPoiReader } from "@openmapx/integration-framework";
import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import type { BBox } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { mapDeOcpdbPayload, mergeDeOcpdbLive } from "./de-ocpdb-mapper.js";
import { getEvChargingSourcePriority } from "./source-priority.js";

const STATION_ID_PREFIX = "de-ocpdb:";

const reader = createTwoTierPoiReader<EvChargingStation>({
  sourceId: "de-ocpdb",
  mapStatic: mapDeOcpdbPayload,
  mergeWithLive: mergeDeOcpdbLive,
  // [west, south, east, north] — Germany (same as de-bnetza).
  coverage: [5.5, 47.1, 15.6, 55.2],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchDeOcpdbCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchDeOcpdbChargingDetail(
  itemId: string,
): Promise<EvChargingStation | null> {
  const poiId = itemId.startsWith(STATION_ID_PREFIX)
    ? itemId.slice(STATION_ID_PREFIX.length)
    : itemId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}

export const deOcpdbSource: EvChargingSource = {
  id: "de-ocpdb",
  priority: getEvChargingSourcePriority("de-ocpdb"),
  search: searchDeOcpdbCharging,
  canFetchDetail: (itemId) => itemId.startsWith(STATION_ID_PREFIX),
  fetchDetail: fetchDeOcpdbChargingDetail,
};
