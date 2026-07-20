import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import { fetchAfdcChargingDetail, searchAfdcCharging } from "./afdc.js";
import { fetchBnetzaChargingDetail, searchBnetzaCharging } from "./bnetza.js";
import { fetchFranceIrveChargingDetail, searchFranceIrveCharging } from "./france.js";
import { fetchNetherlandsChargingDetail, searchNetherlandsCharging } from "./netherlands.js";
import { fetchNobilChargingDetail, searchNobilCharging } from "./nobil.js";
import { getOcmDetail, searchOcm } from "./ocm.js";
import { mapOcmToStation } from "./ocm-mapper.js";
import { getOsmChargingNode, searchOsmCharging } from "./osm.js";
import { mapOsmToStation } from "./osm-mapper.js";
import { getEvChargingSourcePriority } from "./source-priority.js";
import { fetchSwissSfoeChargingDetail, searchSwissSfoeCharging } from "./switzerland.js";

function source(
  id: string,
  search: EvChargingSource["search"],
  detailPrefix: string,
  fetchDetail: (itemId: string) => Promise<EvChargingStation | null>,
): EvChargingSource {
  return {
    id,
    priority: getEvChargingSourcePriority(id),
    search,
    canFetchDetail: (itemId) => itemId.startsWith(detailPrefix),
    fetchDetail,
  };
}

export const EV_CHARGING_SOURCE_REGISTRY: EvChargingSource[] = [
  source("afdc", searchAfdcCharging, "afdc:", fetchAfdcChargingDetail),
  source("bnetza-ev", searchBnetzaCharging, "bnetza:", fetchBnetzaChargingDetail),
  source("france-irve", searchFranceIrveCharging, "france-irve:", fetchFranceIrveChargingDetail),
  source("switzerland-ev", searchSwissSfoeCharging, "swiss-sfoe:", fetchSwissSfoeChargingDetail),
  source("netherlands-ev", searchNetherlandsCharging, "nl-dotnl:", fetchNetherlandsChargingDetail),
  source("nobil", searchNobilCharging, "nobil:", fetchNobilChargingDetail),
  source(
    "ocm",
    async (bbox, filters) => (await searchOcm(bbox, filters)).map(mapOcmToStation),
    "ocm:",
    async (itemId) => {
      const poi = await getOcmDetail(itemId.slice("ocm:".length));
      return poi ? mapOcmToStation(poi) : null;
    },
  ),
  source(
    "osm",
    async (bbox) => (await searchOsmCharging(bbox)).map(mapOsmToStation),
    "osm:",
    async (itemId) => {
      const id = Number.parseInt(itemId.slice("osm:".length), 10);
      if (Number.isNaN(id)) return null;
      const node = await getOsmChargingNode(id);
      return node ? mapOsmToStation(node) : null;
    },
  ),
].sort((a, b) => a.priority - b.priority);
