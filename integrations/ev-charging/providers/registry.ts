import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import { atEcontrolSource } from "./at-econtrol.js";
import { fetchAuNswChargingDetail, searchAuNswCharging } from "./au-nsw.js";
import { fetchAuQldChargingDetail, searchAuQldCharging } from "./au-qld.js";
import { fetchAuVicChargingDetail, searchAuVicCharging } from "./au-vic.js";
import { fetchBeFlandersChargingDetail, searchBeFlandersCharging } from "./be-flanders.js";
import { fetchChSfoeChargingDetail, searchChSfoeCharging } from "./ch-sfoe.js";
import { fetchCyCynapChargingDetail, searchCyCynapCharging } from "./cy-cynap.js";
import { fetchDeBnetzaChargingDetail, searchDeBnetzaCharging } from "./de-bnetza.js";
import { fetchDeOcpdbChargingDetail, searchDeOcpdbCharging } from "./de-ocpdb.js";
import { fetchEsDgtChargingDetail, searchEsDgtCharging } from "./es-dgt.js";
import { fetchFiDigitrafficChargingDetail, searchFiDigitrafficCharging } from "./fi-digitraffic.js";
import { fetchFrIrveChargingDetail, searchFrIrveCharging } from "./fr-irve.js";
import { fetchHkEpdChargingDetail, searchHkEpdCharging } from "./hk-epd.js";
import { fetchIeEsbChargingDetail, searchIeEsbCharging } from "./ie-esb.js";
import { fetchItPunChargingDetail, searchItPunCharging } from "./it-pun.js";
import { fetchKrDatagoChargingDetail, searchKrDatagoCharging } from "./kr-datago.js";
import { fetchLtVialietuvaChargingDetail, searchLtVialietuvaCharging } from "./lt-vialietuva.js";
import { fetchLuChargyChargingDetail, searchLuChargyCharging } from "./lu-chargy.js";
import { fetchNlDotnlChargingDetail, searchNlDotnlCharging } from "./nl-dotnl.js";
import { fetchNoNobilChargingDetail, searchNoNobilCharging } from "./no-nobil.js";
import { fetchNzEvroamChargingDetail, searchNzEvroamCharging } from "./nz-evroam.js";
import { getOcmDetail, searchOcm } from "./ocm.js";
import { mapOcmToStation } from "./ocm-mapper.js";
import { getOsmChargingNode, searchOsmCharging } from "./osm.js";
import { mapOsmToStation } from "./osm-mapper.js";
import { fetchPlEipaChargingDetail, searchPlEipaCharging } from "./pl-eipa.js";
import { fetchSgLtaDatamallChargingDetail, searchSgLtaDatamallCharging } from "./sg-ltadatamall.js";
import { fetchSiNapChargingDetail, searchSiNapCharging } from "./si-nap.js";
import { getEvChargingSourcePriority } from "./source-priority.js";
import { fetchTwTdxChargingDetail, searchTwTdxCharging } from "./tw-tdx.js";
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
  source("cy-cynap", searchCyCynapCharging, "cy-cynap:", fetchCyCynapChargingDetail),
  source("lu-chargy", searchLuChargyCharging, "lu-chargy:", fetchLuChargyChargingDetail),
  source("nz-evroam", searchNzEvroamCharging, "nz-evroam:", fetchNzEvroamChargingDetail),
  source("es-dgt", searchEsDgtCharging, "es-dgt:", fetchEsDgtChargingDetail),
  source("it-pun", searchItPunCharging, "it-pun:", fetchItPunChargingDetail),
  source("au-nsw-ev", searchAuNswCharging, "au-nsw-ev:", fetchAuNswChargingDetail),
  source("au-qld-ev", searchAuQldCharging, "au-qld-ev:", fetchAuQldChargingDetail),
  source("au-vic-ev", searchAuVicCharging, "au-vic-ev:", fetchAuVicChargingDetail),
  source("be-flanders", searchBeFlandersCharging, "be-flanders:", fetchBeFlandersChargingDetail),
  source("hk-epd", searchHkEpdCharging, "hk-epd:", fetchHkEpdChargingDetail),
  source(
    "fi-digitraffic",
    searchFiDigitrafficCharging,
    "fi-digitraffic:",
    fetchFiDigitrafficChargingDetail,
  ),
  source(
    "lt-vialietuva",
    searchLtVialietuvaCharging,
    "lt-vialietuva:",
    fetchLtVialietuvaChargingDetail,
  ),
  source("ch-sfoe", searchChSfoeCharging, "ch-sfoe:", fetchChSfoeChargingDetail),
  source("nl-dotnl", searchNlDotnlCharging, "nl-dotnl:", fetchNlDotnlChargingDetail),
  source("no-nobil", searchNoNobilCharging, "no-nobil:", fetchNoNobilChargingDetail),
  source("si-nap", searchSiNapCharging, "si-nap:", fetchSiNapChargingDetail),
  source("kr-datago", searchKrDatagoCharging, "kr-datago:", fetchKrDatagoChargingDetail),
  source("pl-eipa", searchPlEipaCharging, "pl-eipa:", fetchPlEipaChargingDetail),
  source(
    "sg-ltadatamall",
    searchSgLtaDatamallCharging,
    "sg-ltadatamall:",
    fetchSgLtaDatamallChargingDetail,
  ),
  source("tw-tdx", searchTwTdxCharging, "tw-tdx:", fetchTwTdxChargingDetail),
  atEcontrolSource,
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
