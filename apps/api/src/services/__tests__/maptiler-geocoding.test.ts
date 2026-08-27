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

function makeMaptilerResponse(features: unknown[]) {
  return { features };
}

function makeBerlinFeature(overrides: Record<string, unknown> = {}) {
  return {
    id: "place.123",
    text: "Berlin",
    place_name: "Berlin, Germany",
    place_type: ["poi"],
    relevance: 0.95,
    geometry: { coordinates: [13.37, 52.52] },
    properties: { categories: ["restaurant"] },
    context: [
      { id: "municipality.1", text: "Berlin" },
      { id: "region.1", text: "Brandenburg" },
    ],
    ...overrides,
  };
}

async function loadModule(opts: { withApiKey?: boolean } = { withApiKey: true }) {
  vi.resetModules();
  const mod = await import("@integrations/geocoding-maptiler/provider.js");
  if (opts.withApiKey) mod.setMaptilerApiKey("test-key-123");
  return mod;
}

// geocode

describe("geocode", () => {
  it("maps all fields from a feature correctly", async () => {
    const feature = makeBerlinFeature();
    mockFetch.mockResolvedValueOnce(mockOk(makeMaptilerResponse([feature])));
    const { maptilerGeocodingService } = await loadModule();

    const results = await maptilerGeocodingService.geocode("Berlin");

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("maptiler:place.123");
    expect(results[0].label).toBe("Berlin, Germany");
    expect(results[0].coordinates).toEqual([13.37, 52.52]);
    expect(results[0].type).toBe("poi");
    expect(results[0].confidence).toBe(0.95);
    expect(results[0].rawCategory).toBe("restaurant");
  });

  it('maps place_type "address" to "address"', async () => {
    const feature = makeBerlinFeature({ place_type: ["address"] });
    mockFetch.mockResolvedValueOnce(mockOk(makeMaptilerResponse([feature])));
    const { maptilerGeocodingService } = await loadModule();

    const results = await maptilerGeocodingService.geocode("Berlin");
    expect(results[0].type).toBe("address");
  });

  it('maps place_type "street" to "street"', async () => {
    const feature = makeBerlinFeature({ place_type: ["street"] });
    mockFetch.mockResolvedValueOnce(mockOk(makeMaptilerResponse([feature])));
    const { maptilerGeocodingService } = await loadModule();

    const results = await maptilerGeocodingService.geocode("Berlin");
    expect(results[0].type).toBe("street");
  });

  it('maps place_type "neighbourhood" to "street"', async () => {
    const feature = makeBerlinFeature({ place_type: ["neighbourhood"] });
    mockFetch.mockResolvedValueOnce(mockOk(makeMaptilerResponse([feature])));
    const { maptilerGeocodingService } = await loadModule();

    const results = await maptilerGeocodingService.geocode("Berlin");
    expect(results[0].type).toBe("street");
  });

  it('maps empty place_type to "region"', async () => {
    const feature = makeBerlinFeature({ place_type: [] });
    mockFetch.mockResolvedValueOnce(mockOk(makeMaptilerResponse([feature])));
    const { maptilerGeocodingService } = await loadModule();

    const results = await maptilerGeocodingService.geocode("Berlin");
    expect(results[0].type).toBe("region");
  });

  it('maps unknown place_type to "region"', async () => {
    const feature = makeBerlinFeature({ place_type: ["country"] });
    mockFetch.mockResolvedValueOnce(mockOk(makeMaptilerResponse([feature])));
    const { maptilerGeocodingService } = await loadModule();

    const results = await maptilerGeocodingService.geocode("Berlin");
    expect(results[0].type).toBe("region");
  });

  it("returns undefined rawCategory when no categories", async () => {
    const feature = makeBerlinFeature({ properties: {} });
    mockFetch.mockResolvedValueOnce(mockOk(makeMaptilerResponse([feature])));
    const { maptilerGeocodingService } = await loadModule();

    const results = await maptilerGeocodingService.geocode("Berlin");
    expect(results[0].rawCategory).toBeUndefined();
  });

  it("throws when MAPTILER_KEY is not set", async () => {
    const { maptilerGeocodingService } = await loadModule({ withApiKey: false });

    await expect(maptilerGeocodingService.geocode("Berlin")).rejects.toThrow(
      "MapTiler geocoding requires an API key",
    );
  });

  it("throws on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce(mockNotOk(403));
    const { maptilerGeocodingService } = await loadModule();

    await expect(maptilerGeocodingService.geocode("Berlin")).rejects.toThrow(
      "MapTiler geocoding error 403",
    );
  });
});

// request params

describe("request includes POI types", () => {
  it("geocode requests `types` including poi so station/POIs surface", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(makeMaptilerResponse([])));
    const { maptilerGeocodingService } = await loadModule();

    await maptilerGeocodingService.geocode("Köln Hbf");

    // MapTiler omits POIs from its default response, so "Köln Hbf" returns only
    // addresses (Düren Hbf, …) unless we explicitly ask for poi.
    const types = new URL(String(mockFetch.mock.calls[0][0])).searchParams.get("types");
    expect(types?.split(",")).toContain("poi");
  });

  it("autocomplete requests `types` including poi", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(makeMaptilerResponse([])));
    const { maptilerGeocodingService } = await loadModule();

    await maptilerGeocodingService.autocomplete("Köln Hb");

    const types = new URL(String(mockFetch.mock.calls[0][0])).searchParams.get("types");
    expect(types?.split(",")).toContain("poi");
  });
});

// autocomplete

describe("autocomplete", () => {
  it("maps label from text and sublabel from place_name", async () => {
    const feature = makeBerlinFeature({
      text: "Berlin Hbf",
      place_name: "Berlin Hbf, Berlin, Germany",
    });
    mockFetch.mockResolvedValueOnce(mockOk(makeMaptilerResponse([feature])));
    const { maptilerGeocodingService } = await loadModule();

    const results = await maptilerGeocodingService.autocomplete("Berlin");

    expect(results).toHaveLength(1);
    expect(results[0].label).toBe("Berlin Hbf");
    expect(results[0].sublabel).toBe("Berlin Hbf, Berlin, Germany");
  });

  it("sets iconPath from resolvePoiIconPath when category exists", async () => {
    const feature = makeBerlinFeature({ properties: { categories: ["restaurant"] } });
    mockFetch.mockResolvedValueOnce(mockOk(makeMaptilerResponse([feature])));
    const { maptilerGeocodingService } = await loadModule();

    const results = await maptilerGeocodingService.autocomplete("Berlin");

    // iconPath should be a string (the resolved icon path for "restaurant")
    expect(typeof results[0].iconPath).toBe("string");
    expect(results[0].rawCategory).toBe("restaurant");
  });

  it("sets iconPath to undefined when no category", async () => {
    const feature = makeBerlinFeature({ properties: {} });
    mockFetch.mockResolvedValueOnce(mockOk(makeMaptilerResponse([feature])));
    const { maptilerGeocodingService } = await loadModule();

    const results = await maptilerGeocodingService.autocomplete("Berlin");

    expect(results[0].iconPath).toBeUndefined();
    expect(results[0].rawCategory).toBeUndefined();
  });
});

// reverseGeocode

describe("reverseGeocode", () => {
  it("returns address and city from context", async () => {
    const feature = makeBerlinFeature();
    mockFetch.mockResolvedValueOnce(mockOk(makeMaptilerResponse([feature])));
    const { maptilerGeocodingService } = await loadModule();

    const result = await maptilerGeocodingService.reverseGeocode(52.52, 13.37);

    expect(result).not.toBeNull();
    expect(result?.address).toBe("Berlin, Germany");
    expect(result?.city).toBe("Berlin, Brandenburg");
  });

  it("resolves city from place context prefix", async () => {
    const feature = makeBerlinFeature({
      context: [
        { id: "place.100", text: "Kreuzberg" },
        { id: "state.200", text: "Berlin" },
      ],
    });
    mockFetch.mockResolvedValueOnce(mockOk(makeMaptilerResponse([feature])));
    const { maptilerGeocodingService } = await loadModule();

    const result = await maptilerGeocodingService.reverseGeocode(52.52, 13.37);

    expect(result?.city).toBe("Kreuzberg, Berlin");
  });

  it("returns empty city when no matching context entries", async () => {
    const feature = makeBerlinFeature({ context: [] });
    mockFetch.mockResolvedValueOnce(mockOk(makeMaptilerResponse([feature])));
    const { maptilerGeocodingService } = await loadModule();

    const result = await maptilerGeocodingService.reverseGeocode(52.52, 13.37);

    expect(result?.city).toBe("");
  });

  it("returns null when no features returned", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(makeMaptilerResponse([])));
    const { maptilerGeocodingService } = await loadModule();

    const result = await maptilerGeocodingService.reverseGeocode(52.52, 13.37);

    expect(result).toBeNull();
  });

  it("throws on HTTP error for reverse", async () => {
    mockFetch.mockResolvedValueOnce(mockNotOk(500));
    const { maptilerGeocodingService } = await loadModule();

    await expect(maptilerGeocodingService.reverseGeocode(52.52, 13.37)).rejects.toThrow(
      "MapTiler reverse geocoding error 500",
    );
  });
});
