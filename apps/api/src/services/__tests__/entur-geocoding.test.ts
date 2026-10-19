import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADDRESS,
  collection,
  fixture,
  STOP,
} from "../../../../../integrations/geocoding-entur/test-support.js";

const mockFetch = vi.fn();
const mockOk = (data: unknown) => JSON.stringify(data);
const mockNotOk = (status: number) => ({ status, headers: {}, body: "{}" });
beforeEach(() => mockFetch.mockReset());

const featureCollection = collection;
function osloStopFeature(overrides: Record<string, unknown> = {}) {
  return {
    ...STOP,
    geometry: { type: "Point" as const, coordinates: [10.753051, 59.910357] },
    properties: { ...STOP.properties, id: "NSR:StopPlace:59872", ...overrides },
  };
}
function osloPoiFeature() {
  return {
    ...ADDRESS,
    geometry: { type: "Point" as const, coordinates: [10.752276, 59.911116] },
    properties: {
      ...ADDRESS.properties,
      id: "OSM:TopographicPlace:7118275595",
      source: "openstreetmap" as const,
      layer: "poi" as const,
      names: {
        default: "Espresso House Oslo S Hovedhallen",
        display: "Espresso House Oslo S Hovedhallen, Oslo",
      },
      categories: ["poi", "cafe"],
    },
  };
}
async function loadModule() {
  const instance = fixture({ responder: mockFetch });
  return {
    provider: instance.provider,
    lookupPlaceById: instance.lookupPlaceById,
    http: instance.http,
  };
}

describe("entur autocomplete", () => {
  it("maps NSR stop features to transit-stop suggestions with preserved ids and modes", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(featureCollection([osloStopFeature()])));
    const { provider, http } = await loadModule();

    const results = await provider.autocomplete("Oslo S", "en");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "nsr:StopPlace:59872",
      label: "Oslo S",
      sublabel: "Main stop, Oslo",
      type: "transit_stop",
      rawCategory: "railStation",
      coordinates: [10.753051, 59.910357],
    });
    expect(results[0].transitStop).toMatchObject({
      id: "nsr:StopPlace:59872",
      primaryScheme: "nsr",
      ids: {
        entur: "NSR:StopPlace:59872",
        nsr: "StopPlace:59872",
      },
      name: "Oslo S",
      lat: 59.910357,
      lng: 10.753051,
      modes: ["rail", "bus"],
      provider: "entur",
    });

    const { url, options } = http.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/geocoder/v3/autocomplete");
    expect(parsed.searchParams.get("q")).toBe("Oslo S");
    expect(parsed.searchParams.get("lang")).toBe("en");
    expect(parsed.searchParams.get("countries")).toBe("no");
    expect(parsed.searchParams.get("multimodal")).toBe("parent");
    expect(options?.headers?.["ET-Client-Name"]).toBe("openmapx-tests");
  });

  it("maps POI categories to normal autocomplete results and keeps the specific category", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(featureCollection([osloPoiFeature()])));
    const { provider } = await loadModule();

    const results = await provider.autocomplete("Espresso", "en");

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
    const { provider } = await loadModule();

    const results = await provider.geocode("Oslo S", "en");

    expect(results).toMatchObject([
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
    const { provider } = await loadModule();

    const result = await provider.reverseGeocode(59.911116, 10.752276, "en");

    expect(result).toMatchObject({
      address: "Espresso House Oslo S Hovedhallen, Oslo",
      city: "Oslo",
    });
  });

  it("throws on upstream HTTP errors", async () => {
    mockFetch.mockResolvedValueOnce(mockNotOk(429));
    const { provider } = await loadModule();

    await expect(provider.geocode("Oslo S", "en")).rejects.toThrow(
      "Entur request failed (http, HTTP 429)",
    );
  });
});

describe("lookupPlaceById", () => {
  it("resolves exact NSR ids without the boundary-country filter", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk(
        featureCollection([osloPoiFeature(), osloStopFeature({ description: { eng: "Hub" } })]),
      ),
    );
    const { lookupPlaceById, http } = await loadModule();

    const place = await lookupPlaceById("NSR:StopPlace:59872", "en");

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

    const { url } = http.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/geocoder/v3/place");
    expect(parsed.searchParams.get("ids")).toBe("NSR:StopPlace:59872");
    expect(parsed.searchParams.has("q")).toBe(false);
    expect(parsed.searchParams.has("countries")).toBe(false);
  });
});
