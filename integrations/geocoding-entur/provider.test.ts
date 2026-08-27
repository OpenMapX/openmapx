import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enturFeatureToPlace,
  enturGeocodingService,
  lookupEnturPlaceById,
  setEnturGeocodingConfig,
} from "./provider.js";

let mockFetch: ReturnType<typeof vi.fn>;

function mockOk(data: unknown) {
  return Response.json(data);
}

const STOP_PLACE_FEATURE = {
  geometry: { coordinates: [10.75, 59.911] as [number, number] },
  properties: {
    id: "NSR:StopPlace:337",
    name: "Oslo S",
    label: "Oslo S, Oslo",
    layer: "venue",
    locality: "Oslo",
    county: "Oslo",
    country_a: "NOR",
    category: ["railStation", "busStation"],
    mode: [{ rail: null }, { bus: null }],
  },
};

const STREET_ADDRESS_FEATURE = {
  geometry: { coordinates: [10.74, 59.92] as [number, number] },
  properties: {
    id: "OSM:Address:1",
    name: "Karl Johans gate 1",
    label: "Karl Johans gate 1, Oslo",
    layer: "address",
    locality: "Oslo",
    county: "Oslo",
    country_a: "NOR",
    category: ["Street address"],
  },
};

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  setEnturGeocodingConfig({ clientName: "test-client", boundaryCountry: "NOR" });
});

afterEach(() => {
  setEnturGeocodingConfig({});
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("enturGeocodingService.geocode", () => {
  it("maps a stop-place venue to an NSR-canonical poi search result", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ features: [STOP_PLACE_FEATURE] }));

    const results = await enturGeocodingService.geocode("Oslo S", "en");

    expect(results).toEqual([
      {
        id: "nsr:StopPlace:337",
        label: "Oslo S, Oslo",
        coordinates: [10.75, 59.911],
        type: "poi",
        confidence: 1,
        rawCategory: "railStation",
      },
    ]);
    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain("/autocomplete");
    expect(url).toContain("text=Oslo+S");
    expect(url).toContain("size=10");
    expect(url).toContain("boundary.country=NOR");
  });

  it("maps a street address to the address result type", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ features: [STREET_ADDRESS_FEATURE] }));

    const results = await enturGeocodingService.geocode("Karl Johans gate");

    expect(results[0]).toMatchObject({
      id: "entur:OSM:Address:1",
      type: "address",
      rawCategory: "Street address",
    });
  });

  it("drops features that have no native id or coordinates", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          { geometry: { coordinates: [1, 2] }, properties: { name: "no id" } },
          {
            geometry: {},
            properties: { id: "NSR:StopPlace:1", name: "no coords", layer: "venue" },
          },
        ],
      }),
    );

    expect(await enturGeocodingService.geocode("x")).toEqual([]);
  });
});

describe("enturGeocodingService.autocomplete", () => {
  it("emits a transit_stop result with an embedded transit stop for venues", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ features: [STOP_PLACE_FEATURE] }));

    const results = await enturGeocodingService.autocomplete("Oslo", "en");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "nsr:StopPlace:337",
      label: "Oslo S",
      type: "transit_stop",
      transitStop: {
        id: "nsr:StopPlace:337",
        primaryScheme: "nsr",
        ids: { entur: "NSR:StopPlace:337", nsr: "StopPlace:337" },
        name: "Oslo S",
        lat: 59.911,
        lng: 10.75,
        modes: ["rail", "bus"],
        provider: "entur",
      },
      rawCategory: "railStation",
    });
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("size=6");
  });

  it("emits a non-transit address result without an embedded transit stop", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ features: [STREET_ADDRESS_FEATURE] }));

    const [result] = await enturGeocodingService.autocomplete("Karl");

    expect(result?.id).toBe("entur:OSM:Address:1");
    expect(result?.type).toBe("address");
    expect(result?.transitStop).toBeUndefined();
    expect(result?.rawCategory).toBe("Street address");
  });
});

describe("enturGeocodingService.reverseGeocode", () => {
  it("returns the label and joined city for the first feature", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ features: [STOP_PLACE_FEATURE] }));

    const result = await enturGeocodingService.reverseGeocode(59.911, 10.75, "en");

    expect(result).toEqual({ address: "Oslo S, Oslo", city: "Oslo" });
    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain("/reverse");
    expect(url).toContain("point.lat=59.911");
    expect(url).toContain("point.lon=10.75");
  });

  it("returns null when the reverse response has no features", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ features: [] }));
    expect(await enturGeocodingService.reverseGeocode(0, 0)).toBeNull();
  });
});

describe("enturFeatureToPlace", () => {
  it("builds a station place with NSR identity, city and country code", () => {
    const place = enturFeatureToPlace(STOP_PLACE_FEATURE, "en");

    expect(place).toMatchObject({
      id: "nsr:StopPlace:337",
      primaryScheme: "nsr",
      ids: { entur: "NSR:StopPlace:337", nsr: "StopPlace:337" },
      name: "Oslo S",
      address: "Oslo S, Oslo",
      city: "Oslo",
      countryCode: "no",
      coordinates: [10.75, 59.911],
      category: "station",
      rawCategory: "railStation",
    });
  });

  it.each([
    [{ geometry: { coordinates: [1, 2] }, properties: { name: "no id" } }],
    [{ geometry: {}, properties: { id: "NSR:StopPlace:1" } }],
  ])("returns null for invalid feature %#", (feature) => {
    expect(enturFeatureToPlace(feature)).toBeNull();
  });
});

describe("lookupEnturPlaceById", () => {
  it("resolves the autocomplete feature whose native id matches the request", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        features: [
          { geometry: { coordinates: [1, 2] }, properties: { id: "NSR:StopPlace:999" } },
          STOP_PLACE_FEATURE,
        ],
      }),
    );

    const place = await lookupEnturPlaceById("NSR:StopPlace:337", "en");

    expect(place?.id).toBe("nsr:StopPlace:337");
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("multiModal=all");
  });

  it("returns null when no feature matches the requested id", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ features: [STOP_PLACE_FEATURE] }));
    expect(await lookupEnturPlaceById("NSR:StopPlace:000")).toBeNull();
  });
});
