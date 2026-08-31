import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/nominatim.js", () => ({
  reverseGeocodeCity: vi.fn(),
}));

vi.mock("../src/gbfs-client.js", () => ({
  fetchGbfsSystem: vi.fn(),
}));

vi.mock("../src/gbfs-catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/gbfs-catalog.js")>();
  return {
    ...actual,
    loadCatalog: vi.fn(),
    filterCatalogByBbox: vi.fn((entries: unknown[]) => entries),
    sortByRelevance: vi.fn((entries: unknown[]) => entries),
  };
});

import { loadCatalog } from "../src/gbfs-catalog.js";
import { fetchGbfsSystem } from "../src/gbfs-client.js";
import {
  bboxOverlapsSwitzerland,
  fetchGbfsData,
  fetchSwissSharedMobilityData,
  fetchSwissSharedMobilityDataForBbox,
} from "../src/gbfs-provider-base.js";
import type { MobilityHttpTransport } from "../src/json-transport.js";
import { reverseGeocodeCity } from "../src/nominatim.js";

const transport: MobilityHttpTransport = {
  userAgent: "OpenMapX/test",
  async fetchJson<T>(): Promise<T> {
    throw new Error("Unexpected JSON request");
  },
  async fetchText(): Promise<string> {
    throw new Error("Unexpected text request");
  },
  hostMatchesAllowlist: () => false,
  privateFeedHostAllowlist: () => [],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fetchGbfsData", () => {
  it("sends ET-Client-Name when probing Entur GBFS systems", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.mocked(loadCatalog).mockResolvedValue([
      {
        countryCode: "NO",
        name: "Voi Oslo",
        location: "Oslo",
        systemId: "voioslo",
        url: "https://api.entur.io/mobility/v2/gbfs/v3/voioslo/gbfs",
        autoDiscoveryUrl: "https://api.entur.io/mobility/v2/gbfs/v3/voioslo/gbfs",
      },
    ]);
    vi.mocked(reverseGeocodeCity).mockResolvedValue("Oslo");
    vi.mocked(fetchGbfsSystem).mockResolvedValue({
      systemInfo: {
        systemId: "voioslo",
        name: "VOI",
        operator: "VOI Technology Norway AS",
        timezone: "Europe/Oslo",
      },
      stations: [],
      stationStatuses: new Map(),
      vehicles: [],
      vehicleTypes: new Map(),
      pricingPlans: new Map(),
    });

    const result = await fetchGbfsData(
      { south: 59.9, west: 10.7, north: 59.95, east: 10.8 },
      new Set(["scooter_standing"]),
      transport,
      "other",
    );

    expect(result).toEqual({ stations: [], vehicles: [] });
    expect(fetchGbfsSystem).toHaveBeenCalledWith(
      "https://api.entur.io/mobility/v2/gbfs/v3/voioslo/gbfs",
      { "ET-Client-Name": "openmapx-server" },
      { transport },
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("probes beyond the first relevance slice and fetches systems with bbox coverage", async () => {
    const entries = Array.from({ length: 25 }, (_, index) => ({
      countryCode: "DE",
      name: `Distant system ${index}`,
      location: "Germany",
      systemId: `distant-${index}`,
      url: `https://example.com/distant-${index}`,
      autoDiscoveryUrl: `https://example.com/distant-${index}/gbfs.json`,
    }));
    entries.push({
      countryCode: "DE",
      name: "Late Local Bikes",
      location: "Germany",
      systemId: "late-local",
      url: "https://example.com/late-local",
      autoDiscoveryUrl: "https://example.com/late-local/gbfs.json",
    });

    vi.mocked(loadCatalog).mockResolvedValue(entries);
    vi.mocked(reverseGeocodeCity).mockResolvedValue(null);
    vi.mocked(fetchGbfsSystem).mockImplementation(async (url) => {
      const isLocal = String(url).includes("late-local");
      const lat = isLocal ? 52.5 : 40;
      const lon = isLocal ? 13.4 : 4;
      return {
        systemInfo: {
          systemId: isLocal ? "late-local" : "distant",
          name: isLocal ? "Late Local Bikes" : "Distant",
          timezone: "Europe/Berlin",
        },
        stations: [
          {
            stationId: "station-1",
            name: isLocal ? "Late Local Station" : "Distant Station",
            lat,
            lon,
          },
        ],
        stationStatuses: new Map([
          [
            "station-1",
            {
              stationId: "station-1",
              isInstalled: true,
              isRenting: true,
              numBikesAvailable: 3,
            },
          ],
        ]),
        vehicles: [],
        vehicleTypes: new Map(),
        pricingPlans: new Map(),
      };
    });

    const result = await fetchGbfsData(
      { south: 52.4, west: 13.3, north: 52.6, east: 13.5 },
      new Set(["bicycle"]),
      transport,
    );

    expect(result.stations).toHaveLength(1);
    expect(result.stations[0]).toMatchObject({
      id: "gbfs/late-local/station-1",
      name: "Late Local Station",
    });
    expect(fetchGbfsSystem).toHaveBeenCalledWith(
      "https://example.com/late-local/gbfs.json",
      undefined,
      { transport },
    );
    const lateLocalCalls = vi
      .mocked(fetchGbfsSystem)
      .mock.calls.filter(([url]) => String(url).includes("late-local"));
    expect(lateLocalCalls).toHaveLength(1);
  });

  it("caps country-level probing for large candidate sets", async () => {
    vi.mocked(fetchGbfsSystem).mockClear();
    const entries = Array.from({ length: 80 }, (_, index) => ({
      countryCode: "US",
      name: `System ${index}`,
      location: "United States",
      systemId: `system-${index}`,
      url: `https://example.com/system-${index}`,
      autoDiscoveryUrl: `https://example.com/system-${index}/gbfs.json`,
    }));

    vi.mocked(loadCatalog).mockResolvedValue(entries);
    vi.mocked(reverseGeocodeCity).mockResolvedValue(null);
    vi.mocked(fetchGbfsSystem).mockResolvedValue({
      systemInfo: {
        systemId: "distant",
        name: "Distant",
        timezone: "America/New_York",
      },
      stations: [
        {
          stationId: "station-1",
          name: "Distant Station",
          lat: 40,
          lon: -75,
        },
      ],
      stationStatuses: new Map(),
      vehicles: [],
      vehicleTypes: new Map(),
      pricingPlans: new Map(),
    });

    const result = await fetchGbfsData(
      { south: 34.0, west: -118.5, north: 34.2, east: -118.1 },
      new Set(["bicycle"]),
      transport,
    );

    expect(result).toEqual({ stations: [], vehicles: [] });
    expect(fetchGbfsSystem).toHaveBeenCalledTimes(64);
  });
});

describe("fetchSwissSharedMobilityData", () => {
  it("probes the official sharedmobility.ch discovery feed directly", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.mocked(fetchGbfsSystem).mockClear();
    vi.mocked(loadCatalog).mockClear();
    vi.mocked(fetchGbfsSystem).mockResolvedValue({
      systemInfo: {
        systemId: "sharedmobility.ch",
        name: "sharedmobility.ch",
        operator: "sharedmobility.ch",
        timezone: "Europe/Zurich",
      },
      stations: [],
      stationStatuses: new Map(),
      vehicles: [],
      vehicleTypes: new Map(),
      pricingPlans: new Map(),
    });

    const result = await fetchSwissSharedMobilityData(
      { south: 46.9, west: 7.3, north: 47.0, east: 7.5 },
      new Set(["bicycle"]),
      transport,
    );

    expect(result).toEqual({ stations: [], vehicles: [] });
    expect(fetchGbfsSystem).toHaveBeenCalledWith("https://sharedmobility.ch/gbfs.json", undefined, {
      transport,
    });
    expect(loadCatalog).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("returns empty data without request-path logging when discovery fails", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.mocked(fetchGbfsSystem).mockClear();
    vi.mocked(fetchGbfsSystem).mockResolvedValue(null);

    const result = await fetchSwissSharedMobilityData(
      { south: 46.9, west: 7.3, north: 47.0, east: 7.5 },
      new Set(["bicycle"]),
      transport,
    );

    expect(result).toEqual({ stations: [], vehicles: [] });
    expect(fetchGbfsSystem).toHaveBeenCalledWith("https://sharedmobility.ch/gbfs.json", undefined, {
      transport,
    });
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("fetchSwissSharedMobilityDataForBbox", () => {
  it("keeps the Switzerland coverage decision in the shared GBFS layer", async () => {
    vi.mocked(fetchGbfsSystem).mockClear();

    const result = await fetchSwissSharedMobilityDataForBbox(
      { south: 48.0, west: 11.0, north: 49.0, east: 12.0 },
      new Set(["bicycle"]),
      transport,
    );

    expect(result).toEqual({ stations: [], vehicles: [] });
    expect(bboxOverlapsSwitzerland({ south: 48.0, west: 11.0, north: 49.0, east: 12.0 })).toBe(
      false,
    );
    expect(fetchGbfsSystem).not.toHaveBeenCalled();
  });
});
