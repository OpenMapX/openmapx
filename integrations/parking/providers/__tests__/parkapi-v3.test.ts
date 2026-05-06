import { afterEach, describe, expect, it, vi } from "vitest";

const API_BASE = "https://api.mobidata-bw.de/park-api/api/public/v3/parking-sites";
const SOURCES_API = "https://api.mobidata-bw.de/park-api/api/public/v3/sources";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function loadProvider() {
  vi.resetModules();
  return import("../parkapi-v3.js");
}

describe("parkapi-v3 provider", () => {
  it("enriches car parking sites with source metadata and quality warnings", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-06T12:00:00.000Z"));
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === API_BASE) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 1,
                name: "Kongressgarage",
                lat: "48.7758",
                lon: "9.1829",
                capacity: 80,
                realtime_free_capacity: 120,
                purpose: "CAR",
                source_uid: "bw",
                type: "UNDERGROUND",
                has_realtime_data: true,
                realtime_data_updated_at: "2026-05-06T11:00:00.000Z",
              },
              {
                id: 2,
                name: "Bike box",
                lat: "48.776",
                lon: "9.183",
                capacity: 20,
                purpose: "BIKE",
                source_uid: "bw",
                type: "BIKE_BOX",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === SOURCES_API) {
        return new Response(
          JSON.stringify({
            items: [
              {
                uid: "bw",
                name: "MobiData BW",
                public_url: "https://mobidata-bw.de/",
                static_data_updated_at: "2026-05-06T10:00:00.000Z",
                realtime_data_updated_at: "2026-05-06T11:00:00.000Z",
                attribution_contributor: "MobiData BW",
                attribution_license: "dl-de/by-2-0",
                attribution_url: "https://www.govdata.de/dl-de/by-2-0",
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { searchParkApiV3 } = await loadProvider();
    const results = await searchParkApiV3({
      east: 9.3,
      north: 48.9,
      south: 48.6,
      west: 9.0,
    });

    expect(results).toEqual([
      expect.objectContaining({
        capacity: 80,
        dataUpdatedAt: "2026-05-06T11:00:00.000Z",
        freeSpaces: 80,
        hasRealtimeData: true,
        id: "parkapi-v3:1",
        isStale: true,
        parkingType: "underground",
        qualityWarnings: [
          "Realtime free-space count exceeded capacity and was clamped.",
          "Realtime availability is older than 30 minutes.",
        ],
        realtimeDataUpdatedAt: "2026-05-06T11:00:00.000Z",
        sourceAttribution: expect.objectContaining({
          contributor: "MobiData BW",
          license: "dl-de/by-2-0",
        }),
        sourceName: "MobiData BW",
        sourceUid: "bw",
        sourceUrl: "https://mobidata-bw.de/",
        staticDataUpdatedAt: "2026-05-06T10:00:00.000Z",
      }),
    ]);
  });

  it("enriches detail responses with source metadata", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === `${API_BASE}/7`) {
        return new Response(
          JSON.stringify({
            id: 7,
            name: "Bahnhof Parkhaus",
            lat: "48.7",
            lon: "9.1",
            capacity: 40,
            purpose: "CAR",
            source_uid: "rail",
            type: "CAR_PARK",
          }),
          { status: 200 },
        );
      }
      if (url === SOURCES_API) {
        return new Response(
          JSON.stringify({
            items: [
              {
                uid: "rail",
                name: "Rail parking source",
                public_url: "https://parking.example/",
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchParkApiV3Detail } = await loadProvider();
    const detail = await fetchParkApiV3Detail(7);

    expect(detail).toEqual(
      expect.objectContaining({
        id: "parkapi-v3:7",
        parkingType: "garage",
        sourceName: "Rail parking source",
        sourceUid: "rail",
      }),
    );
  });
});
