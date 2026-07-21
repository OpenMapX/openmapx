import type { BoundingBox } from "@openmapx/core";
import type { Logger } from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../de-apag.js", () => ({ searchDeApag: vi.fn(), fetchDeApagDetail: vi.fn() }));
vi.mock("../de-apag-mobidrom.js", () => ({
  searchDeApagMobidrom: vi.fn(),
  fetchDeApagMobidromDetail: vi.fn(),
}));
vi.mock("../de-apcoa.js", () => ({ searchDeApcoa: vi.fn(), fetchDeApcoaDetail: vi.fn() }));
vi.mock("../de-autobahn.js", () => ({
  searchDeAutobahn: vi.fn(),
  fetchDeAutobahnDetail: vi.fn(),
}));
vi.mock("../de-by-bamberg.js", () => ({
  searchDeByBamberg: vi.fn(),
  fetchDeByBambergDetail: vi.fn(),
}));
vi.mock("../es-ct-barcelona.js", () => ({
  searchEsCtBarcelona: vi.fn(),
  fetchEsCtBarcelonaDetail: vi.fn(),
}));
vi.mock("../ch-bs-basel.js", () => ({ searchChBsBasel: vi.fn(), fetchChBsBaselDetail: vi.fn() }));
vi.mock("../de-nw-bielefeld.js", () => ({
  searchDeNwBielefeld: vi.fn(),
  fetchDeNwBielefeldDetail: vi.fn(),
}));
vi.mock("../fr-bnls.js", () => ({ searchFrBnls: vi.fn(), fetchFrBnlsDetail: vi.fn() }));
vi.mock("../de-ni-braunschweig.js", () => ({
  searchDeNiBraunschweig: vi.fn(),
  fetchDeNiBraunschweigDetail: vi.fn(),
}));
vi.mock("../de-hb-bremen.js", () => ({
  searchDeHbBremen: vi.fn(),
  fetchDeHbBremenDetail: vi.fn(),
}));
vi.mock("../be-bru-brussels.js", () => ({
  searchBeBruBrussels: vi.fn(),
  fetchBeBruBrusselsDetail: vi.fn(),
}));
vi.mock("../lu-cita.js", () => ({ searchLuCita: vi.fn(), fetchLuCitaDetail: vi.fn() }));
vi.mock("../dk-84-copenhagen.js", () => ({
  searchDk84Copenhagen: vi.fn(),
  fetchDk84CopenhagenDetail: vi.fn(),
}));
vi.mock("../de-db-bahnpark.js", () => ({
  searchDeDbBahnPark: vi.fn(),
  fetchDeDbBahnParkDetail: vi.fn(),
}));
vi.mock("../dedup.js", () => ({ deduplicateParking: vi.fn((items: unknown[]) => items) }));
vi.mock("../de-nw-duesseldorf.js", () => ({
  searchDeNwDuesseldorf: vi.fn(),
  fetchDeNwDuesseldorfDetail: vi.fn(),
}));
vi.mock("../it-52-florence.js", () => ({
  searchIt52Florence: vi.fn(),
  fetchIt52FlorenceDetail: vi.fn(),
}));
vi.mock("../be-vlg-ghent.js", () => ({
  searchBeVlgGhent: vi.fn(),
  fetchBeVlgGhentDetail: vi.fn(),
}));
vi.mock("../de-goldbeck.js", () => ({ searchDeGoldbeck: vi.fn(), fetchDeGoldbeckDetail: vi.fn() }));
vi.mock("../es-md-madrid.js", () => ({
  searchEsMdMadrid: vi.fn(),
  fetchEsMdMadridDetail: vi.fn(),
}));
vi.mock("../mapper.js", () => ({
  mapParkingToResult: vi.fn((f) => f),
  mapParkingToDetail: vi.fn(),
}));
vi.mock("../nl-ndw-truck.js", () => ({
  searchNlNdwTruck: vi.fn(),
  fetchNlNdwTruckDetail: vi.fn(),
}));
vi.mock("../de-nw-mobidrom.js", () => ({
  searchDeNwMobidrom: vi.fn(),
  fetchDeNwMobidromDetail: vi.fn(),
}));
vi.mock("../de-nw-mobidrom-pr.js", () => ({
  searchDeNwMobidromPr: vi.fn(),
  fetchDeNwMobidromPrDetail: vi.fn(),
}));
vi.mock("../au-nsw.js", () => ({ searchAuNsw: vi.fn(), fetchAuNswDetail: vi.fn() }));
vi.mock("../it-32-opendatahub.js", () => ({
  searchIt32Opendatahub: vi.fn(),
  fetchIt32OpendatahubDetail: vi.fn(),
}));
vi.mock("../ch-otd.js", () => ({
  searchChOtd: vi.fn(),
  fetchChOtdDetail: vi.fn(),
}));
vi.mock("../osm.js", () => ({ searchOsmParking: vi.fn(), fetchOsmParkingElement: vi.fn() }));
vi.mock("../de-parkapi-v2.js", () => ({
  searchDeParkapiV2: vi.fn(),
  fetchDeParkapiV2Detail: vi.fn(),
}));
vi.mock("../de-parkapi-v3.js", () => ({
  searchDeParkapiV3: vi.fn(),
  fetchDeParkapiV3Detail: vi.fn(),
}));
vi.mock("../de-bb-potsdam.js", () => ({
  searchDeBbPotsdam: vi.fn(),
  fetchDeBbPotsdamDetail: vi.fn(),
}));
vi.mock("../nl-rdw.js", () => ({ searchNlRdw: vi.fn(), fetchNlRdwDetail: vi.fn() }));
vi.mock("../at-5-salzburg.js", () => ({
  searchAt5Salzburg: vi.fn(),
  fetchAt5SalzburgDetail: vi.fn(),
}));
vi.mock("../sg-hdb.js", () => ({ searchSgHdb: vi.fn(), fetchSgHdbDetail: vi.fn() }));
vi.mock("../de-rp-trier.js", () => ({ searchDeRpTrier: vi.fn(), fetchDeRpTrierDetail: vi.fn() }));
vi.mock("../gb-eng-utmc.js", () => ({
  searchGbEngUtmc: vi.fn(),
  fetchGbEngUtmcDetail: vi.fn(),
}));
vi.mock("../at-9-vienna.js", () => ({ searchAt9Vienna: vi.fn(), fetchAt9ViennaDetail: vi.fn() }));

import { searchAt5Salzburg } from "../at-5-salzburg.js";
import { searchAt9Vienna } from "../at-9-vienna.js";
import { searchAuNsw } from "../au-nsw.js";
import { searchBeBruBrussels } from "../be-bru-brussels.js";
import { searchBeVlgGhent } from "../be-vlg-ghent.js";
import { searchChBsBasel } from "../ch-bs-basel.js";
import { searchChOtd } from "../ch-otd.js";
import { searchDeApag } from "../de-apag.js";
import { searchDeApagMobidrom } from "../de-apag-mobidrom.js";
import { searchDeApcoa } from "../de-apcoa.js";
import { searchDeAutobahn } from "../de-autobahn.js";
import { searchDeBbPotsdam } from "../de-bb-potsdam.js";
import { searchDeByBamberg } from "../de-by-bamberg.js";
import { searchDeDbBahnPark } from "../de-db-bahnpark.js";
import { searchDeGoldbeck } from "../de-goldbeck.js";
import { searchDeHbBremen } from "../de-hb-bremen.js";
import { searchDeNiBraunschweig } from "../de-ni-braunschweig.js";
import { searchDeNwBielefeld } from "../de-nw-bielefeld.js";
import { searchDeNwDuesseldorf } from "../de-nw-duesseldorf.js";
import { searchDeNwMobidrom } from "../de-nw-mobidrom.js";
import { searchDeNwMobidromPr } from "../de-nw-mobidrom-pr.js";
import { searchDeParkapiV2 } from "../de-parkapi-v2.js";
import { searchDeParkapiV3 } from "../de-parkapi-v3.js";
import { searchDeRpTrier } from "../de-rp-trier.js";
import { deduplicateParking } from "../dedup.js";
import { searchDk84Copenhagen } from "../dk-84-copenhagen.js";
import { searchEsCtBarcelona } from "../es-ct-barcelona.js";
import { searchEsMdMadrid } from "../es-md-madrid.js";
import { searchFrBnls } from "../fr-bnls.js";
import { searchGbEngUtmc } from "../gb-eng-utmc.js";
import { searchIt32Opendatahub } from "../it-32-opendatahub.js";
import { searchIt52Florence } from "../it-52-florence.js";
import { searchLuCita } from "../lu-cita.js";
import { searchNlNdwTruck } from "../nl-ndw-truck.js";
import { searchNlRdw } from "../nl-rdw.js";
import { searchOsmParking } from "../osm.js";
import { parkingProvider, setLogger, setManifestDataSources } from "../provider.js";
import { searchSgHdb } from "../sg-hdb.js";

const ALL_SEARCH_FUNS = [
  searchDeDbBahnPark,
  searchDeParkapiV3,
  searchDeNwMobidrom,
  searchDeNwMobidromPr,
  searchDeApag,
  searchDeApagMobidrom,
  searchDeParkapiV2,
  searchChOtd,
  searchNlRdw,
  searchFrBnls,
  searchBeVlgGhent,
  searchBeBruBrussels,
  searchChBsBasel,
  searchIt52Florence,
  searchEsCtBarcelona,
  searchAt9Vienna,
  searchDk84Copenhagen,
  searchSgHdb,
  searchEsMdMadrid,
  searchGbEngUtmc,
  searchAuNsw,
  searchNlNdwTruck,
  searchDeAutobahn,
  searchIt32Opendatahub,
  searchLuCita,
  searchDeApcoa,
  searchDeGoldbeck,
  searchDeNiBraunschweig,
  searchDeHbBremen,
  searchDeNwDuesseldorf,
  searchAt5Salzburg,
  searchDeNwBielefeld,
  searchDeByBamberg,
  searchDeRpTrier,
  searchDeBbPotsdam,
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
    vi.mocked(searchDeParkapiV3).mockRejectedValue(failErr);
    vi.mocked(deduplicateParking).mockImplementation((items) => items);

    await parkingProvider.search(makeBbox());

    expect(log.warn).toHaveBeenCalledOnce();
    const [msg, err] = log.warnCalls[0];
    expect(msg).toContain("de-parkapi-v3");
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
