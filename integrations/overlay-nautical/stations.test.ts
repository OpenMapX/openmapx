import { describe, expect, it, vi } from "vitest";

const { fetchJson } = vi.hoisted(() => ({ fetchJson: vi.fn() }));

vi.mock("@openmapx/core", async (importActual) => {
  const actual = await importActual<typeof import("@openmapx/core")>();
  return { ...actual, fetchJson };
});

import { createNoopLogger, createPassthroughCache } from "@openmapx/integration-framework/testing";
import {
  dedupTideStations,
  iso3to2,
  loadAllTideStations,
  type MergedTideStation,
  stationsInBbox,
} from "./stations.js";

function station(over: Partial<MergedTideStation>): MergedTideStation {
  return {
    network: "noaa",
    id: "x",
    name: "X",
    lat: 0,
    lng: 0,
    types: ["water-level"],
    ...over,
  };
}

describe("iso3to2", () => {
  it.each([
    ["GBR", "GB"],
    ["DEU", "DE"],
    ["usa", "US"],
    ["DMK", "DK"],
    ["DNK", "DK"],
  ])("maps alpha-3 %s to alpha-2 %s", (a3, a2) => {
    expect(iso3to2(a3)).toBe(a2);
  });

  it("returns undefined for unknown or missing codes (no wrong guesses)", () => {
    expect(iso3to2("ZZZ")).toBeUndefined();
    expect(iso3to2(undefined)).toBeUndefined();
    expect(iso3to2("")).toBeUndefined();
  });
});

describe("stationsInBbox", () => {
  const stations = [
    station({ id: "in", lat: 50, lng: 5 }),
    station({ id: "north", lat: 60, lng: 5 }),
    station({ id: "west", lat: 50, lng: -5 }),
    station({ id: "tide", lat: 50.5, lng: 5.5, types: ["tide-predictions"] }),
    station({ id: "ioc", network: "ioc", lat: 50.2, lng: 5.2 }),
  ];
  const bbox = { west: 0, south: 45, east: 10, north: 55 };

  it("keeps only stations inside the bbox (inclusive edges)", () => {
    const ids = stationsInBbox(stations, bbox).map((s) => s.id);
    expect(ids).toContain("in");
    expect(ids).not.toContain("north");
    expect(ids).not.toContain("west");
  });

  it("filters by capability type", () => {
    const ids = stationsInBbox(stations, bbox, { type: "tide-predictions" }).map((s) => s.id);
    expect(ids).toEqual(["tide"]);
  });

  it("filters by network", () => {
    const ids = stationsInBbox(stations, bbox, { network: "ioc" }).map((s) => s.id);
    expect(ids).toEqual(["ioc"]);
  });
});

describe("dedupTideStations", () => {
  it("drops the lower-ranked network when two stations overlap within 500m", () => {
    // NOAA (rank 0) and IOC (rank 5) ~100m apart -> keep NOAA only.
    const out = dedupTideStations([
      station({ network: "ioc", id: "i1", lat: 44.65, lng: -63.57 }),
      station({ network: "noaa", id: "n1", lat: 44.6501, lng: -63.5701 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].network).toBe("noaa");
  });

  it("keeps both when they are farther apart than the dedup radius", () => {
    const out = dedupTideStations([
      station({ network: "noaa", id: "n1", lat: 44.0, lng: -63.0 }),
      station({ network: "ioc", id: "i1", lat: 45.0, lng: -64.0 }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("dedups same-network duplicates by network:id", () => {
    const out = dedupTideStations([
      station({ network: "pegel", id: "dup", lat: 53.5, lng: 8.1 }),
      station({ network: "pegel", id: "dup", lat: 53.5, lng: 8.1 }),
    ]);
    expect(out).toHaveLength(1);
  });

  it("honors a custom radius", () => {
    const pair = [
      station({ network: "noaa", id: "a", lat: 10, lng: 10 }),
      station({ network: "ioc", id: "b", lat: 10.05, lng: 10 }), // ~5.5km apart
    ];
    expect(dedupTideStations(pair, 0.5)).toHaveLength(2);
    expect(dedupTideStations(pair, 10)).toHaveLength(1);
  });
});

describe("loadAllTideStations", () => {
  it("normalizes each network's raw shape into MergedTideStation, filtering bad rows", async () => {
    const cache = createPassthroughCache();
    const log = createNoopLogger();

    fetchJson.mockImplementation(async (url: string) => {
      if (url.includes("ioc-sealevelmonitoring")) {
        return [
          { Code: "abc", Location: "Active IOC", country: "GBR", Lat: 51.5, Lon: -0.1, status: 1 },
          { Code: "old", Location: "Inactive", Lat: 1, Lon: 1, status: 0 },
          { Code: "nan", Location: "Bad coords", Lat: Number.NaN, Lon: 2, status: 1 },
        ];
      }
      if (url.includes("emodnet-physics")) {
        const recent = new Date().toISOString();
        const ancient = "1990-01-01T00:00:00Z";
        return {
          features: [
            {
              geometry: { coordinates: [10.0, 54.0] },
              properties: { platformcode: "EMO1", last_date_observation: recent },
            },
            {
              geometry: { coordinates: [11.0, 55.0] },
              properties: { platformcode: "EMOLD", last_date_observation: ancient },
            },
          ],
        };
      }
      if (url.includes("api-iwls.dfo")) {
        return [
          {
            id: "ca-id-1",
            code: "00065",
            officialName: "Halifax",
            latitude: 44.666,
            longitude: -63.583,
            operating: true,
            timeSeries: [{ code: "wlp" }, { code: "wlo" }, { code: "wcs1" }],
          },
        ];
      }
      // Pegelonline
      return [
        {
          uuid: "uuid-1",
          shortname: "CUXHAVEN  STEUBENHOEFT",
          longname: "CUXHAVEN",
          latitude: 53.87,
          longitude: 8.72,
        },
      ];
    });

    // Kartverket uses raw fetch (XML); stub it to a non-OK response so it yields [].
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503 }) as Response),
    );

    const out = await loadAllTideStations(cache, log, "test-ua");
    vi.unstubAllGlobals();

    const iocRequest = fetchJson.mock.calls.find(([url]) =>
      String(url).includes("ioc-sealevelmonitoring"),
    );
    expect(String(iocRequest?.[0])).toMatch(
      /^https:\/\/www\.ioc-sealevelmonitoring\.org\/service\.php\?/,
    );

    const byNetwork = (n: MergedTideStation["network"]) => out.filter((s) => s.network === n);

    // IOC: only the active, valid-coord station, with alpha-2 country.
    expect(byNetwork("ioc")).toEqual([
      {
        network: "ioc",
        id: "abc",
        name: "Active IOC",
        lat: 51.5,
        lng: -0.1,
        types: ["water-level"],
        country: "GB",
      },
    ]);

    // EMODnet: stale (1990) observation filtered out; coordinates are [lng,lat].
    expect(byNetwork("emodnet")).toHaveLength(1);
    expect(byNetwork("emodnet")[0]).toMatchObject({ id: "EMO1", lat: 54.0, lng: 10.0 });

    // Canada: time-series codes map to capabilities.
    expect(byNetwork("ca-iwls")[0]).toMatchObject({
      id: "ca-id-1",
      name: "Halifax",
      types: ["tide-predictions", "water-level", "currents"],
      country: "CA",
    });

    // Pegelonline: whitespace collapsed in the name.
    expect(byNetwork("pegel")[0]).toMatchObject({
      id: "uuid-1",
      name: "CUXHAVEN STEUBENHOEFT",
      country: "DE",
    });
  });
});
