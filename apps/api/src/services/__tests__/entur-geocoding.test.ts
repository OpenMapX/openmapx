import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, streamedJsonResponse } from "../../test/streamed-response.js";

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockOk(data: unknown) {
  return streamedJsonResponse(data);
}

function mockNotOk(status = 500) {
  return emptyResponse(status);
}

function featureCollection(features: unknown[]) {
  return { features };
}

function osloStopFeature(overrides: Record<string, unknown> = {}) {
  return {
    geometry: { coordinates: [10.753051, 59.910357] },
    properties: {
      id: "NSR:StopPlace:59872",
      source_id: "NSR:StopPlace:59872",
      layer: "venue",
      name: "Oslo S",
      label: "Oslo S, Oslo",
      locality: "Oslo",
      county: "Oslo",
      country_a: "NOR",
      category: ["onstreetBus", "railStation"],
      mode: [{ bus: "railReplacementBus" }, { rail: null }],
      description: [{ eng: "Main stop" }],
      ...overrides,
    },
  };
}

function osloPoiFeature(overrides: Record<string, unknown> = {}) {
  return {
    geometry: { coordinates: [10.752276, 59.911116] },
    properties: {
      id: "OSM:TopographicPlace:7118275595",
      source_id: "OSM:TopographicPlace:7118275595",
      layer: "address",
      name: "Espresso House Oslo S Hovedhallen",
      label: "Espresso House Oslo S Hovedhallen, Oslo",
      locality: "Oslo",
      county: "Oslo",
      country_a: "NOR",
      category: ["poi", "cafe"],
      ...overrides,
    },
  };
}

async function loadModule() {
  vi.resetModules();
  const mod = await import("@integrations/geocoding-entur/provider.js");
  mod.setEnturGeocodingConfig({
    endpoint: "https://api.entur.io/geocoder/v1",
    clientName: "openmapx-tests",
    boundaryCountry: "NOR",
    multiModal: "parent",
  });
  return mod;
}

describe("entur autocomplete", () => {
  it("maps NSR stop features to transit-stop suggestions with preserved ids and modes", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(featureCollection([osloStopFeature()])));
    const { enturGeocodingService } = await loadModule();

    const results = await enturGeocodingService.autocomplete("Oslo S", "en");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "nsr:StopPlace:59872",
      label: "Oslo S",
      sublabel: "Main stop, Oslo",
      type: "transit_stop",
      rawCategory: "railStation",
      coordinates: [10.753051, 59.910357],
    });
    expect(results[0].transitStop).toEqual({
      id: "nsr:StopPlace:59872",
      primaryScheme: "nsr",
      ids: {
        entur: "NSR:StopPlace:59872",
        nsr: "StopPlace:59872",
      },
      name: "Oslo S",
      lat: 59.910357,
      lng: 10.753051,
      modes: ["bus", "rail"],
      provider: "entur",
    });

    const [url, options] = mockFetch.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/geocoder/v1/autocomplete");
    expect(parsed.searchParams.get("text")).toBe("Oslo S");
    expect(parsed.searchParams.get("lang")).toBe("en");
    expect(parsed.searchParams.get("boundary.country")).toBe("NOR");
    expect(parsed.searchParams.get("multiModal")).toBe("parent");
    expect(options.headers["ET-Client-Name"]).toBe("openmapx-tests");
  });

  it("maps POI categories to normal autocomplete results and keeps the specific category", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(featureCollection([osloPoiFeature()])));
    const { enturGeocodingService } = await loadModule();

    const results = await enturGeocodingService.autocomplete("Espresso", "en");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "entur:OSM:TopographicPlace:7118275595",
      label: "Espresso House Oslo S Hovedhallen",
      sublabel: "Oslo",
      type: "poi",
      rawCategory: "cafe",
      coordinates: [10.752276, 59.911116],
    });
    expect(typeof results[0].iconPath).toBe("string");
    expect(results[0].transitStop).toBeUndefined();
  });
});

describe("entur geocode and reverse", () => {
  it("maps forward geocoding results using canonical ids", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(featureCollection([osloStopFeature()])));
    const { enturGeocodingService } = await loadModule();

    const results = await enturGeocodingService.geocode("Oslo S", "en");

    expect(results).toEqual([
      {
        id: "nsr:StopPlace:59872",
        label: "Oslo S, Oslo",
        coordinates: [10.753051, 59.910357],
        type: "poi",
        confidence: 1,
        rawCategory: "railStation",
      },
    ]);
  });

  it("maps reverse geocoding to address and city", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(featureCollection([osloPoiFeature()])));
    const { enturGeocodingService } = await loadModule();

    const result = await enturGeocodingService.reverseGeocode(59.911116, 10.752276, "en");

    expect(result).toEqual({
      address: "Espresso House Oslo S Hovedhallen, Oslo",
      city: "Oslo",
    });
  });

  it("throws on upstream HTTP errors", async () => {
    mockFetch.mockResolvedValueOnce(mockNotOk(429));
    const { enturGeocodingService } = await loadModule();

    await expect(enturGeocodingService.geocode("Oslo S", "en")).rejects.toThrow(
      "Entur geocoding error 429",
    );
  });
});

describe("lookupEnturPlaceById", () => {
  it("resolves exact NSR ids without the boundary-country filter", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk(
        featureCollection([osloPoiFeature(), osloStopFeature({ description: [{ eng: "Hub" }] })]),
      ),
    );
    const { lookupEnturPlaceById } = await loadModule();

    const place = await lookupEnturPlaceById("NSR:StopPlace:59872", "en");

    expect(place).toMatchObject({
      id: "nsr:StopPlace:59872",
      primaryScheme: "nsr",
      ids: {
        entur: "NSR:StopPlace:59872",
        nsr: "StopPlace:59872",
      },
      name: "Oslo S",
      address: "Oslo S, Oslo",
      city: "Oslo",
      countryCode: "no",
      coordinates: [10.753051, 59.910357],
      category: "station",
      rawCategory: "railStation",
      description: "Hub",
    });

    const [url] = mockFetch.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.searchParams.get("text")).toBe("NSR:StopPlace:59872");
    expect(parsed.searchParams.get("multiModal")).toBe("all");
    expect(parsed.searchParams.has("boundary.country")).toBe(false);
  });
});
