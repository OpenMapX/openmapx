import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import { fetchChSfoeChargingDetail, searchChSfoeCharging } from "./ch-sfoe.js";
import { fetchDeBnetzaChargingDetail, searchDeBnetzaCharging } from "./de-bnetza.js";
import { fetchDeOcpdbChargingDetail, searchDeOcpdbCharging } from "./de-ocpdb.js";
import { fetchFrIrveChargingDetail, searchFrIrveCharging } from "./fr-irve.js";
import { fetchIeEsbChargingDetail, searchIeEsbCharging } from "./ie-esb.js";
import { fetchNlDotnlChargingDetail, searchNlDotnlCharging } from "./nl-dotnl.js";
import { fetchNoNobilChargingDetail, searchNoNobilCharging } from "./no-nobil.js";
import { getOcmDetail, searchOcm } from "./ocm.js";
import { mapOcmToStation } from "./ocm-mapper.js";
import { getOsmChargingNode, searchOsmCharging } from "./osm.js";
import { mapOsmToStation } from "./osm-mapper.js";
import { getEvChargingSourcePriority } from "./source-priority.js";
import { fetchUsAfdcChargingDetail, searchUsAfdcCharging } from "./us-afdc.js";

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
  source("us-afdc", searchUsAfdcCharging, "us-afdc:", fetchUsAfdcChargingDetail),
  source("de-bnetza", searchDeBnetzaCharging, "de-bnetza:", fetchDeBnetzaChargingDetail),
  source("de-ocpdb", searchDeOcpdbCharging, "de-ocpdb:", fetchDeOcpdbChargingDetail),
  source("fr-irve", searchFrIrveCharging, "fr-irve:", fetchFrIrveChargingDetail),
  source("ie-esb", searchIeEsbCharging, "ie-esb:", fetchIeEsbChargingDetail),
  source("ch-sfoe", searchChSfoeCharging, "ch-sfoe:", fetchChSfoeChargingDetail),
  source("nl-dotnl", searchNlDotnlCharging, "nl-dotnl:", fetchNlDotnlChargingDetail),
  source("no-nobil", searchNoNobilCharging, "no-nobil:", fetchNoNobilChargingDetail),
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
