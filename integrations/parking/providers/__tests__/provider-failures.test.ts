import type { BoundingBox } from "@openmapx/core";
import type { Logger } from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../apag.js", () => ({ searchApag: vi.fn(), fetchApagDetail: vi.fn() }));
vi.mock("../apag-mobidrom.js", () => ({
  searchApagMobidrom: vi.fn(),
  fetchApagMobidromDetail: vi.fn(),
}));
vi.mock("../apcoa.js", () => ({ searchApcoa: vi.fn(), fetchApcoaDetail: vi.fn() }));
vi.mock("../autobahn-de.js", () => ({
  searchAutobahnDe: vi.fn(),
  fetchAutobahnDeDetail: vi.fn(),
}));
vi.mock("../bamberg-de.js", () => ({ searchBambergDe: vi.fn(), fetchBambergDeDetail: vi.fn() }));
vi.mock("../barcelona-es.js", () => ({
  searchBarcelonaEs: vi.fn(),
  fetchBarcelonaEsDetail: vi.fn(),
}));
vi.mock("../basel-ch.js", () => ({ searchBaselCh: vi.fn(), fetchBaselChDetail: vi.fn() }));
vi.mock("../bielefeld-de.js", () => ({
  searchBielefeldDe: vi.fn(),
  fetchBielefeldDeDetail: vi.fn(),
}));
vi.mock("../bnls-fr.js", () => ({ searchBnlsFr: vi.fn(), fetchBnlsFrDetail: vi.fn() }));
vi.mock("../braunschweig-de.js", () => ({
  searchBraunschweigDe: vi.fn(),
  fetchBraunschweigDeDetail: vi.fn(),
}));
vi.mock("../bremen-de.js", () => ({ searchBremenDe: vi.fn(), fetchBremenDeDetail: vi.fn() }));
vi.mock("../brussels-be.js", () => ({
  searchBrusselsBe: vi.fn(),
  fetchBrusselsBeDetail: vi.fn(),
}));
vi.mock("../cita-lu.js", () => ({ searchCitaLu: vi.fn(), fetchCitaLuDetail: vi.fn() }));
vi.mock("../copenhagen-dk.js", () => ({
  searchCopenhagenDk: vi.fn(),
  fetchCopenhagenDkDetail: vi.fn(),
}));
vi.mock("../db-bahnpark.js", () => ({
  searchDbBahnPark: vi.fn(),
  fetchDbBahnParkDetail: vi.fn(),
}));
vi.mock("../dedup.js", () => ({ deduplicateParking: vi.fn((items: unknown[]) => items) }));
vi.mock("../duesseldorf-de.js", () => ({
  searchDuesseldorfDe: vi.fn(),
  fetchDuesseldorfDeDetail: vi.fn(),
}));
vi.mock("../florence-it.js", () => ({
  searchFlorenceIt: vi.fn(),
  fetchFlorenceItDetail: vi.fn(),
}));
vi.mock("../ghent-be.js", () => ({ searchGhentBe: vi.fn(), fetchGhentBeDetail: vi.fn() }));
vi.mock("../goldbeck.js", () => ({ searchGoldbeck: vi.fn(), fetchGoldbeckDetail: vi.fn() }));
vi.mock("../madrid-es.js", () => ({ searchMadridEs: vi.fn(), fetchMadridEsDetail: vi.fn() }));
vi.mock("../mapper.js", () => ({
  mapParkingToResult: vi.fn((f) => f),
  mapParkingToDetail: vi.fn(),
}));
vi.mock("../ndw-truck-nl.js", () => ({
  searchNdwTruckNl: vi.fn(),
  fetchNdwTruckNlDetail: vi.fn(),
}));
vi.mock("../nrw-mobidrom.js", () => ({
  searchNrwMobidrom: vi.fn(),
  fetchNrwMobidromDetail: vi.fn(),
}));
vi.mock("../nrw-pr.js", () => ({ searchNrwPr: vi.fn(), fetchNrwPrDetail: vi.fn() }));
vi.mock("../nsw-au.js", () => ({ searchNswAu: vi.fn(), fetchNswAuDetail: vi.fn() }));
vi.mock("../opendatahub-it.js", () => ({
  searchOdhIt: vi.fn(),
  fetchOdhItDetail: vi.fn(),
}));
vi.mock("../opentransportdata-ch.js", () => ({
  searchOpenTransportDataChParking: vi.fn(),
  fetchOpenTransportDataChParkingDetail: vi.fn(),
}));
vi.mock("../osm.js", () => ({ searchOsmParking: vi.fn(), fetchOsmParkingElement: vi.fn() }));
vi.mock("../parkapi-v2.js", () => ({
  searchParkApiV2: vi.fn(),
  fetchParkApiV2Detail: vi.fn(),
}));
vi.mock("../parkapi-v3.js", () => ({
  searchParkApiV3: vi.fn(),
  fetchParkApiV3Detail: vi.fn(),
}));
vi.mock("../potsdam-de.js", () => ({
  searchPotsdamDe: vi.fn(),
  fetchPotsdamDeDetail: vi.fn(),
}));
vi.mock("../rdw-nl.js", () => ({ searchRdwNl: vi.fn(), fetchRdwNlDetail: vi.fn() }));
vi.mock("../salzburg-at.js", () => ({
  searchSalzburgAt: vi.fn(),
  fetchSalzburgAtDetail: vi.fn(),
}));
vi.mock("../singapore.js", () => ({ searchSingapore: vi.fn(), fetchSingaporeDetail: vi.fn() }));
vi.mock("../trier-de.js", () => ({ searchTrierDe: vi.fn(), fetchTrierDeDetail: vi.fn() }));
vi.mock("../utmc-newcastle.js", () => ({
  searchUtmcNewcastle: vi.fn(),
  fetchUtmcNewcastleDetail: vi.fn(),
}));
vi.mock("../vienna-at.js", () => ({ searchViennaAt: vi.fn(), fetchViennaAtDetail: vi.fn() }));

import { searchApag } from "../apag.js";
import { searchApagMobidrom } from "../apag-mobidrom.js";
import { searchApcoa } from "../apcoa.js";
import { searchAutobahnDe } from "../autobahn-de.js";
import { searchBambergDe } from "../bamberg-de.js";
import { searchBarcelonaEs } from "../barcelona-es.js";
import { searchBaselCh } from "../basel-ch.js";
import { searchBielefeldDe } from "../bielefeld-de.js";
import { searchBnlsFr } from "../bnls-fr.js";
import { searchBraunschweigDe } from "../braunschweig-de.js";
import { searchBremenDe } from "../bremen-de.js";
import { searchBrusselsBe } from "../brussels-be.js";
import { searchCitaLu } from "../cita-lu.js";
import { searchCopenhagenDk } from "../copenhagen-dk.js";
import { searchDbBahnPark } from "../db-bahnpark.js";
import { deduplicateParking } from "../dedup.js";
import { searchDuesseldorfDe } from "../duesseldorf-de.js";
import { searchFlorenceIt } from "../florence-it.js";
import { searchGhentBe } from "../ghent-be.js";
import { searchGoldbeck } from "../goldbeck.js";
import { searchMadridEs } from "../madrid-es.js";
import { searchNdwTruckNl } from "../ndw-truck-nl.js";
import { searchNrwMobidrom } from "../nrw-mobidrom.js";
import { searchNrwPr } from "../nrw-pr.js";
import { searchNswAu } from "../nsw-au.js";
import { searchOdhIt } from "../opendatahub-it.js";
import { searchOpenTransportDataChParking } from "../opentransportdata-ch.js";
import { searchOsmParking } from "../osm.js";
import { searchParkApiV2 } from "../parkapi-v2.js";
import { searchParkApiV3 } from "../parkapi-v3.js";
import { searchPotsdamDe } from "../potsdam-de.js";
import { parkingProvider, setLogger, setManifestDataSources } from "../provider.js";
import { searchRdwNl } from "../rdw-nl.js";
import { searchSalzburgAt } from "../salzburg-at.js";
import { searchSingapore } from "../singapore.js";
import { searchTrierDe } from "../trier-de.js";
import { searchUtmcNewcastle } from "../utmc-newcastle.js";
import { searchViennaAt } from "../vienna-at.js";

const ALL_SEARCH_FUNS = [
  searchDbBahnPark,
  searchParkApiV3,
  searchNrwMobidrom,
  searchNrwPr,
  searchApag,
  searchApagMobidrom,
  searchParkApiV2,
  searchOpenTransportDataChParking,
  searchRdwNl,
  searchBnlsFr,
  searchGhentBe,
  searchBrusselsBe,
  searchBaselCh,
  searchFlorenceIt,
  searchBarcelonaEs,
  searchViennaAt,
  searchCopenhagenDk,
  searchSingapore,
  searchMadridEs,
  searchUtmcNewcastle,
  searchNswAu,
  searchNdwTruckNl,
  searchAutobahnDe,
  searchOdhIt,
  searchCitaLu,
  searchApcoa,
  searchGoldbeck,
  searchBraunschweigDe,
  searchBremenDe,
  searchDuesseldorfDe,
  searchSalzburgAt,
  searchBielefeldDe,
  searchBambergDe,
  searchTrierDe,
  searchPotsdamDe,
  searchOsmParking,
];

function makeBbox(): BoundingBox {
  return { south: 48.0, west: 11.0, north: 49.0, east: 12.0 };
}

function makeLogger(): Logger & {
  warnCalls: Array<[string, unknown]>;
  errorCalls: Array<[string, unknown]>;
} {
  const warnCalls: Array<[string, unknown]> = [];
  const errorCalls: Array<[string, unknown]> = [];
  return {
    warnCalls,
    errorCalls,
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn((msg: string, ...args: unknown[]) => {
      warnCalls.push([msg, args[0]]);
    }),
    error: vi.fn((msg: string, ...args: unknown[]) => {
      errorCalls.push([msg, args[0]]);
    }),
  };
}

beforeEach(() => {
  setManifestDataSources([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parking source failure logging", () => {
  it("one source rejects: results from healthy source returned and log.warn called with source id", async () => {
    const log = makeLogger();
    setLogger(log);

    const failErr = new Error("upstream down");
    for (const fn of ALL_SEARCH_FUNS) {
      vi.mocked(fn).mockResolvedValue([]);
    }
    vi.mocked(searchParkApiV3).mockRejectedValue(failErr);
    vi.mocked(deduplicateParking).mockImplementation((items) => items);

    await parkingProvider.search(makeBbox());

    expect(log.warn).toHaveBeenCalledOnce();
    const [msg, err] = log.warnCalls[0];
    expect(msg).toContain("parkapi-v3");
    expect(err).toBe(failErr);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("all sources reject: empty data returned and log.error called once", async () => {
    const log = makeLogger();
    setLogger(log);

    for (const fn of ALL_SEARCH_FUNS) {
      vi.mocked(fn).mockRejectedValue(new Error("down"));
    }
    vi.mocked(deduplicateParking).mockReturnValue([]);

    const result = await parkingProvider.search(makeBbox());

    expect(result.data).toEqual([]);
    expect(log.error).toHaveBeenCalledOnce();
    expect(vi.mocked(log.error).mock.calls[0][0]).toContain("all parking sources failed");
    expect(log.warn).toHaveBeenCalledTimes(ALL_SEARCH_FUNS.length);
  });

  it("happy path: all sources resolve and no log calls are made", async () => {
    const log = makeLogger();
    setLogger(log);

    for (const fn of ALL_SEARCH_FUNS) {
      vi.mocked(fn).mockResolvedValue([]);
    }
    vi.mocked(deduplicateParking).mockReturnValue([]);

    await parkingProvider.search(makeBbox());

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});
