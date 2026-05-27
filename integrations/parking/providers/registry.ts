import type { BoundingBox } from "@openmapx/core";
import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import { fetchApagDetail, searchApag } from "./apag.js";
import { fetchApagMobidromDetail, searchApagMobidrom } from "./apag-mobidrom.js";
import { fetchApcoaDetail, searchApcoa } from "./apcoa.js";
import { fetchAutobahnDeDetail, searchAutobahnDe } from "./autobahn-de.js";
import { fetchBambergDeDetail, searchBambergDe } from "./bamberg-de.js";
import { fetchBarcelonaEsDetail, searchBarcelonaEs } from "./barcelona-es.js";
import { fetchBaselChDetail, searchBaselCh } from "./basel-ch.js";
import { fetchBielefeldDeDetail, searchBielefeldDe } from "./bielefeld-de.js";
import { fetchBnlsFrDetail, searchBnlsFr } from "./bnls-fr.js";
import { fetchBraunschweigDeDetail, searchBraunschweigDe } from "./braunschweig-de.js";
import { fetchBremenDeDetail, searchBremenDe } from "./bremen-de.js";
import { fetchBrusselsBeDetail, searchBrusselsBe } from "./brussels-be.js";
import { fetchCitaLuDetail, searchCitaLu } from "./cita-lu.js";
import { fetchCopenhagenDkDetail, searchCopenhagenDk } from "./copenhagen-dk.js";
import { fetchDbBahnParkDetail, searchDbBahnPark } from "./db-bahnpark.js";
import { fetchDuesseldorfDeDetail, searchDuesseldorfDe } from "./duesseldorf-de.js";
import { fetchFlorenceItDetail, searchFlorenceIt } from "./florence-it.js";
import { fetchGhentBeDetail, searchGhentBe } from "./ghent-be.js";
import { fetchGoldbeckDetail, searchGoldbeck } from "./goldbeck.js";
import { fetchMadridEsDetail, searchMadridEs } from "./madrid-es.js";
import { fetchNdwTruckNlDetail, searchNdwTruckNl } from "./ndw-truck-nl.js";
import { fetchNrwMobidromDetail, searchNrwMobidrom } from "./nrw-mobidrom.js";
import { fetchNrwPrDetail, searchNrwPr } from "./nrw-pr.js";
import { fetchNswAuDetail, searchNswAu } from "./nsw-au.js";
import { fetchOdhItDetail, searchOdhIt } from "./opendatahub-it.js";
import {
  fetchOpenTransportDataChParkingDetail,
  searchOpenTransportDataChParking,
} from "./opentransportdata-ch.js";
import { fetchOsmParkingElement, searchOsmParking } from "./osm.js";
import { fetchParkApiV2Detail, searchParkApiV2 } from "./parkapi-v2.js";
import { fetchParkApiV3Detail, searchParkApiV3 } from "./parkapi-v3.js";
import { fetchPotsdamDeDetail, searchPotsdamDe } from "./potsdam-de.js";
import { fetchRdwNlDetail, searchRdwNl } from "./rdw-nl.js";
import { fetchSalzburgAtDetail, searchSalzburgAt } from "./salzburg-at.js";
import { fetchSingaporeDetail, searchSingapore } from "./singapore.js";
import { getParkingSourcePriority } from "./source-priority.js";
import { fetchTrierDeDetail, searchTrierDe } from "./trier-de.js";
import { fetchUtmcNewcastleDetail, searchUtmcNewcastle } from "./utmc-newcastle.js";
import { fetchViennaAtDetail, searchViennaAt } from "./vienna-at.js";

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
  entry("db-bahnpark", searchDbBahnPark, "db-bahnpark:", fetchDbBahnParkDetail),
  entry("parkapi-v3", searchParkApiV3, "parkapi-v3:", async (rest) => {
    const siteId = Number.parseInt(rest, 10);
    return Number.isNaN(siteId) ? null : fetchParkApiV3Detail(siteId);
  }),
  entry("nrw-mobidrom-parking", searchNrwMobidrom, "nrw:", fetchNrwMobidromDetail),
  entry("nrw-mobidrom-pr", searchNrwPr, "nrw-pr:", fetchNrwPrDetail),
  entry("apag", searchApag, "apag:", fetchApagDetail),
  entry("apag-mobidrom", searchApagMobidrom, "apag-mobidrom:", fetchApagMobidromDetail),
  entry("parkapi-v2", searchParkApiV2, "parkapi-v2:", async (rest) => {
    const slashIdx = rest.indexOf("/");
    if (slashIdx <= 0) return null;
    return fetchParkApiV2Detail(rest.slice(0, slashIdx), rest.slice(slashIdx + 1));
  }),
  entry("opentransportdata-ch-parking", searchOpenTransportDataChParking, "otdch-parking:", (id) =>
    fetchOpenTransportDataChParkingDetail(id),
  ),
  entry("rdw-nl", searchRdwNl, "rdw:", async (rest) => {
    const slashIdx = rest.indexOf("/");
    if (slashIdx <= 0) return null;
    return fetchRdwNlDetail(rest.slice(0, slashIdx), rest.slice(slashIdx + 1));
  }),
  entry("bnls-fr", searchBnlsFr, "bnls:", fetchBnlsFrDetail),
  entry("ghent-be", searchGhentBe, "ghent:", fetchGhentBeDetail),
  entry("brussels-be", searchBrusselsBe, "brussels:", fetchBrusselsBeDetail),
  entry("basel-ch", searchBaselCh, "basel:", fetchBaselChDetail),
  entry("florence-it", searchFlorenceIt, "florence:", fetchFlorenceItDetail),
  entry("barcelona-es", searchBarcelonaEs, "barcelona:", fetchBarcelonaEsDetail),
  entry("vienna-at", searchViennaAt, "vienna:", fetchViennaAtDetail),
  entry("copenhagen-dk", searchCopenhagenDk, "copenhagen:", fetchCopenhagenDkDetail),
  entry("singapore", searchSingapore, "sg:", fetchSingaporeDetail),
  entry("madrid-es", searchMadridEs, "madrid:", fetchMadridEsDetail),
  entry("utmc-newcastle", searchUtmcNewcastle, "utmc:", fetchUtmcNewcastleDetail),
  entry("nsw-au", searchNswAu, "nsw:", fetchNswAuDetail),
  entry("ndw-truck-nl", searchNdwTruckNl, "ndw-truck:", fetchNdwTruckNlDetail),
  entry("autobahn-de", searchAutobahnDe, "autobahn:", fetchAutobahnDeDetail),
  entry("opendatahub-it", searchOdhIt, "odh:", fetchOdhItDetail),
  entry("cita-lu", searchCitaLu, "cita-lu:", fetchCitaLuDetail),
  entry("apcoa", searchApcoa, "apcoa:", fetchApcoaDetail),
  entry("goldbeck", searchGoldbeck, "goldbeck:", fetchGoldbeckDetail),
  // Direct municipal/operator feeds for individual cities.
  entry("braunschweig-de", searchBraunschweigDe, "braunschweig:", fetchBraunschweigDeDetail),
  entry("bremen-de", searchBremenDe, "bremen:", fetchBremenDeDetail),
  entry("duesseldorf-de", searchDuesseldorfDe, "duesseldorf:", fetchDuesseldorfDeDetail),
  entry("salzburg-at", searchSalzburgAt, "salzburg:", fetchSalzburgAtDetail),
  entry("bielefeld-de", searchBielefeldDe, "bielefeld:", fetchBielefeldDeDetail),
  entry("bamberg-de", searchBambergDe, "bamberg:", fetchBambergDeDetail),
  entry("trier-de", searchTrierDe, "trier:", fetchTrierDeDetail),
  entry("potsdam-de", searchPotsdamDe, "potsdam:", fetchPotsdamDeDetail),
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
