import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbRisGeocodingService, lookupDbStation } from "./provider.js";
import { setRisCredentials } from "./ris-client.js";
import type { RisStopPlace } from "./stations-types.js";

let mockFetch: ReturnType<typeof vi.fn>;

function mockOk(data: unknown) {
  return Response.json(data);
}

function mockError(status = 500) {
  return { ok: false, status, statusText: "err", json: async () => ({}) } as Response;
}

const KOELN_HBF: RisStopPlace = {
  evaNumber: "8000207",
  names: { DE: { nameLong: "Köln Hbf" }, EN: { nameLong: "Cologne Central" } },
  metropolis: { DE: "Köln", EN: "Cologne" },
  position: { longitude: 6.9589, latitude: 50.9431 },
  availableTransports: [{ type: "HIGH_SPEED_TRAIN" }, { type: "SUBWAY" }, { type: "BUS" }],
};

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  setRisCredentials({ clientId: "cid", apiKey: "key" });
});

afterEach(() => {
  setRisCredentials({});
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("dbRisGeocodingService.geocode", () => {
  it("maps stop places to eva-prefixed search results", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ stopPlaces: [KOELN_HBF] }));

    const results = await dbRisGeocodingService.geocode("Köln", "en");

    expect(results).toEqual([
      {
        id: "eva:8000207",
        label: "Cologne Central, Cologne",
        coordinates: [6.9589, 50.9431],
        type: "poi",
        confidence: 1,
        rawCategory: "railway/station",
      },
    ]);
    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain("/stop-places/by-name/");
    expect(url).toContain("limit=10");
  });

  it("returns an empty array when credentials are not configured", async () => {
    setRisCredentials({});
    expect(await dbRisGeocodingService.geocode("Köln")).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("swallows upstream errors and returns an empty array", async () => {
    mockFetch.mockResolvedValueOnce(mockError(503));
    expect(await dbRisGeocodingService.geocode("Köln")).toEqual([]);
  });
});

describe("dbRisGeocodingService.autocomplete", () => {
  it("maps stop places to transit_stop autocomplete results", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ stopPlaces: [KOELN_HBF] }));

    const results = await dbRisGeocodingService.autocomplete("Köln");

    expect(results).toEqual([
      {
        id: "eva:8000207",
        label: "Köln Hbf",
        sublabel: "Köln",
        coordinates: [6.9589, 50.9431],
        type: "transit_stop",
        transitStop: {
          id: "eva:8000207",
          name: "Köln Hbf",
          lat: 50.9431,
          lng: 6.9589,
          modes: ["rail", "subway", "bus"],
          provider: "db-ris",
        },
        rawCategory: "railway/station",
      },
    ]);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("limit=6");
  });
});

describe("dbRisGeocodingService.reverseGeocode", () => {
  it("returns the nearest station name and city for the requested language", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ stopPlaces: [KOELN_HBF] }));

    const result = await dbRisGeocodingService.reverseGeocode(50.9431, 6.9589, "en");

    expect(result).toEqual({ address: "Cologne Central", city: "Cologne" });
    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain("/stop-places/by-position");
    expect(url).toContain("latitude=50.9431");
    expect(url).toContain("radius=200");
  });

  it("falls back to the EVA number when no localized name exists", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        stopPlaces: [{ evaNumber: "999", names: {}, position: { longitude: 1, latitude: 2 } }],
      }),
    );

    const result = await dbRisGeocodingService.reverseGeocode(2, 1);
    expect(result).toEqual({ address: "EVA 999", city: "" });
  });

  it("returns null when no station is near the point", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ stopPlaces: [] }));
    expect(await dbRisGeocodingService.reverseGeocode(0, 0)).toBeNull();
  });
});

describe("lookupDbStation", () => {
  it("merges the base place with a station detail built from all sub-endpoints", async () => {
    mockFetch
      .mockResolvedValueOnce(mockOk(KOELN_HBF))
      .mockResolvedValueOnce(
        mockOk({
          platforms: [{ name: "1", length: 400, accessibility: { stepFreeAccess: true } }],
        }),
      )
      .mockResolvedValueOnce(
        mockOk({ connectingTimes: [{ type: "COMMUTER", defaultDuration: 5 }] }),
      )
      .mockResolvedValueOnce(mockOk({ localServices: [{ name: "Lockers", category: "storage" }] }));

    const result = await lookupDbStation("8000207", "en");

    expect(result).toMatchObject({
      id: "eva:8000207",
      name: "Cologne Central",
      city: "Cologne",
    });
    const detail = result.dataSourceDetail as { source: string; sections: unknown[] };
    expect(detail.source).toBe("db-station");
    expect(detail.sections).toHaveLength(3);
  });

  it("tolerates failures in the optional detail endpoints", async () => {
    mockFetch
      .mockResolvedValueOnce(mockOk(KOELN_HBF))
      .mockResolvedValueOnce(mockError(500))
      .mockResolvedValueOnce(mockError(500))
      .mockResolvedValueOnce(mockError(500));

    const result = await lookupDbStation("8000207");
    const detail = result.dataSourceDetail as { sections: unknown[] };
    expect(detail.sections).toEqual([]);
  });
});
