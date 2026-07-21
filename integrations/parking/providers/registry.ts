import type { BoundingBox } from "@openmapx/core";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import { fetchAt5SalzburgDetail, searchAt5Salzburg } from "./at-5-salzburg.js";
import { fetchAt9ViennaDetail, searchAt9Vienna } from "./at-9-vienna.js";
import { fetchAuNswDetail, searchAuNsw } from "./au-nsw.js";
import { fetchBeBruBrusselsDetail, searchBeBruBrussels } from "./be-bru-brussels.js";
import { fetchBeVlgGhentDetail, searchBeVlgGhent } from "./be-vlg-ghent.js";
import { fetchChBsBaselDetail, searchChBsBasel } from "./ch-bs-basel.js";
import { fetchChOtdDetail, searchChOtd } from "./ch-otd.js";
import { fetchDeApagDetail, searchDeApag } from "./de-apag.js";
import { fetchDeApagMobidromDetail, searchDeApagMobidrom } from "./de-apag-mobidrom.js";
import { fetchDeApcoaDetail, searchDeApcoa } from "./de-apcoa.js";
import { fetchDeAutobahnDetail, searchDeAutobahn } from "./de-autobahn.js";
import { fetchDeBbPotsdamDetail, searchDeBbPotsdam } from "./de-bb-potsdam.js";
import { fetchDeByBambergDetail, searchDeByBamberg } from "./de-by-bamberg.js";
import { fetchDeDbBahnParkDetail, searchDeDbBahnPark } from "./de-db-bahnpark.js";
import { fetchDeGoldbeckDetail, searchDeGoldbeck } from "./de-goldbeck.js";
import { fetchDeHbBremenDetail, searchDeHbBremen } from "./de-hb-bremen.js";
import { fetchDeNiBraunschweigDetail, searchDeNiBraunschweig } from "./de-ni-braunschweig.js";
import { fetchDeNwBielefeldDetail, searchDeNwBielefeld } from "./de-nw-bielefeld.js";
import { fetchDeNwDuesseldorfDetail, searchDeNwDuesseldorf } from "./de-nw-duesseldorf.js";
import { fetchDeNwMobidromDetail, searchDeNwMobidrom } from "./de-nw-mobidrom.js";
import { fetchDeNwMobidromPrDetail, searchDeNwMobidromPr } from "./de-nw-mobidrom-pr.js";
import { fetchDeParkapiV2Detail, searchDeParkapiV2 } from "./de-parkapi-v2.js";
import { fetchDeParkapiV3Detail, searchDeParkapiV3 } from "./de-parkapi-v3.js";
import { fetchDeRpTrierDetail, searchDeRpTrier } from "./de-rp-trier.js";
import { fetchDk84CopenhagenDetail, searchDk84Copenhagen } from "./dk-84-copenhagen.js";
import { fetchEsCtBarcelonaDetail, searchEsCtBarcelona } from "./es-ct-barcelona.js";
import { fetchEsMdMadridDetail, searchEsMdMadrid } from "./es-md-madrid.js";
import { fetchFrBnlsDetail, searchFrBnls } from "./fr-bnls.js";
import { fetchGbEngUtmcDetail, searchGbEngUtmc } from "./gb-eng-utmc.js";
import { fetchIt32OpendatahubDetail, searchIt32Opendatahub } from "./it-32-opendatahub.js";
import { fetchIt52FlorenceDetail, searchIt52Florence } from "./it-52-florence.js";
import { fetchLuCitaDetail, searchLuCita } from "./lu-cita.js";
import { fetchNlNdwTruckDetail, searchNlNdwTruck } from "./nl-ndw-truck.js";
import { fetchNlRdwDetail, searchNlRdw } from "./nl-rdw.js";
import { fetchOsmParkingElement, searchOsmParking } from "./osm.js";
import { fetchSgHdbDetail, searchSgHdb } from "./sg-hdb.js";
import { getParkingSourcePriority } from "./source-priority.js";

export interface ParkingSourceRegistryEntry {
  id: string;
  priority: number;
  search: (bbox: BoundingBox) => Promise<ParkingFacility[]>;
  canFetchDetail?: (itemId: string) => boolean;
  fetchDetail?: (itemId: string) => Promise<ParkingFacility | null>;
}

function entry(
  id: string,
  search: (bbox: BoundingBox) => Promise<ParkingFacility[]>,
  detailPrefix: string,
  fetchDetail: (rest: string) => Promise<ParkingFacility | null>,
): ParkingSourceRegistryEntry {
  return {
    id,
    priority: getParkingSourcePriority(id),
    search,
    canFetchDetail: (itemId) => itemId.startsWith(detailPrefix),
    fetchDetail: (itemId) => fetchDetail(itemId.slice(detailPrefix.length)),
  };
}

export const PARKING_SOURCE_REGISTRY: ParkingSourceRegistryEntry[] = [
  entry("de-db-bahnpark", searchDeDbBahnPark, "de-db-bahnpark:", fetchDeDbBahnParkDetail),
  entry("de-parkapi-v3", searchDeParkapiV3, "de-parkapi-v3:", async (rest) => {
    const siteId = Number.parseInt(rest, 10);
    return Number.isNaN(siteId) ? null : fetchDeParkapiV3Detail(siteId);
  }),
  entry("de-nw-mobidrom", searchDeNwMobidrom, "de-nw-mobidrom:", fetchDeNwMobidromDetail),
  entry("de-nw-mobidrom-pr", searchDeNwMobidromPr, "de-nw-mobidrom-pr:", fetchDeNwMobidromPrDetail),
  entry("de-apag", searchDeApag, "de-apag:", fetchDeApagDetail),
  entry("de-apag-mobidrom", searchDeApagMobidrom, "de-apag-mobidrom:", fetchDeApagMobidromDetail),
  entry("de-parkapi-v2", searchDeParkapiV2, "de-parkapi-v2:", async (rest) => {
    const slashIdx = rest.indexOf("/");
    if (slashIdx <= 0) return null;
    return fetchDeParkapiV2Detail(rest.slice(0, slashIdx), rest.slice(slashIdx + 1));
  }),
  entry("ch-otd", searchChOtd, "ch-otd:", (id) => fetchChOtdDetail(id)),
  entry("nl-rdw", searchNlRdw, "nl-rdw:", async (rest) => {
    const slashIdx = rest.indexOf("/");
    if (slashIdx <= 0) return null;
    return fetchNlRdwDetail(rest.slice(0, slashIdx), rest.slice(slashIdx + 1));
  }),
  entry("fr-bnls", searchFrBnls, "fr-bnls:", fetchFrBnlsDetail),
  entry("be-vlg-ghent", searchBeVlgGhent, "be-vlg-ghent:", fetchBeVlgGhentDetail),
  entry("be-bru-brussels", searchBeBruBrussels, "be-bru-brussels:", fetchBeBruBrusselsDetail),
  entry("ch-bs-basel", searchChBsBasel, "ch-bs-basel:", fetchChBsBaselDetail),
  entry("it-52-florence", searchIt52Florence, "it-52-florence:", fetchIt52FlorenceDetail),
  entry("es-ct-barcelona", searchEsCtBarcelona, "es-ct-barcelona:", fetchEsCtBarcelonaDetail),
  entry("at-9-vienna", searchAt9Vienna, "at-9-vienna:", fetchAt9ViennaDetail),
  entry("dk-84-copenhagen", searchDk84Copenhagen, "dk-84-copenhagen:", fetchDk84CopenhagenDetail),
  entry("sg-hdb", searchSgHdb, "sg-hdb:", fetchSgHdbDetail),
  entry("es-md-madrid", searchEsMdMadrid, "es-md-madrid:", fetchEsMdMadridDetail),
  entry("gb-eng-utmc", searchGbEngUtmc, "gb-eng-utmc:", fetchGbEngUtmcDetail),
  entry("au-nsw", searchAuNsw, "au-nsw:", fetchAuNswDetail),
  entry("nl-ndw-truck", searchNlNdwTruck, "nl-ndw-truck:", fetchNlNdwTruckDetail),
  entry("de-autobahn", searchDeAutobahn, "de-autobahn:", fetchDeAutobahnDetail),
  entry(
    "it-32-opendatahub",
    searchIt32Opendatahub,
    "it-32-opendatahub:",
    fetchIt32OpendatahubDetail,
  ),
  entry("lu-cita", searchLuCita, "lu-cita:", fetchLuCitaDetail),
  entry("de-apcoa", searchDeApcoa, "de-apcoa:", fetchDeApcoaDetail),
  entry("de-goldbeck", searchDeGoldbeck, "de-goldbeck:", fetchDeGoldbeckDetail),
  // Direct municipal/operator feeds for individual cities.
  entry(
    "de-ni-braunschweig",
    searchDeNiBraunschweig,
    "de-ni-braunschweig:",
    fetchDeNiBraunschweigDetail,
  ),
  entry("de-hb-bremen", searchDeHbBremen, "de-hb-bremen:", fetchDeHbBremenDetail),
  entry(
    "de-nw-duesseldorf",
    searchDeNwDuesseldorf,
    "de-nw-duesseldorf:",
    fetchDeNwDuesseldorfDetail,
  ),
  entry("at-5-salzburg", searchAt5Salzburg, "at-5-salzburg:", fetchAt5SalzburgDetail),
  entry("de-nw-bielefeld", searchDeNwBielefeld, "de-nw-bielefeld:", fetchDeNwBielefeldDetail),
  entry("de-by-bamberg", searchDeByBamberg, "de-by-bamberg:", fetchDeByBambergDetail),
  entry("de-rp-trier", searchDeRpTrier, "de-rp-trier:", fetchDeRpTrierDetail),
  entry("de-bb-potsdam", searchDeBbPotsdam, "de-bb-potsdam:", fetchDeBbPotsdamDetail),
  {
    id: "osm",
    priority: getParkingSourcePriority("osm"),
    search: searchOsmParking,
    canFetchDetail: (itemId: string) => itemId.startsWith("osm:"),
    fetchDetail: async (itemId: string) => {
      const rest = itemId.slice("osm:".length);
      const [elementType, idStr] = rest.split("/");
      const elementId = Number.parseInt(idStr, 10);
      if (!elementType || Number.isNaN(elementId)) return null;
      return fetchOsmParkingElement(elementType, elementId);
    },
  },
].sort((a, b) => a.priority - b.priority);
