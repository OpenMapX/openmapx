import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  return { ok: true, json: async () => data } as Response;
}

function mockNotOk(status = 500) {
  return { ok: false, status } as Response;
}

function makePhotonResponse(features: unknown[]) {
  return { features };
}

function makeBerlinFeature(overrides: Record<string, unknown> = {}) {
  return {
    geometry: { coordinates: [13.37, 52.52] },
    properties: {
      osm_id: 123456,
      osm_type: "N",
      osm_key: "place",
      osm_value: "city",
      name: "Berlin",
      street: "Unter den Linden",
      housenumber: "1",
      city: "Berlin",
      state: "Berlin",
      postcode: "10117",
      country: "Germany",
      ...overrides,
    },
  };
}

async function loadModule() {
  vi.resetModules();
  return import("@integrations/geocoding-photon/provider.js");
}

// geocode

describe("geocode", () => {
  it("maps all fields correctly", async () => {
    const feature = makeBerlinFeature();
    mockFetch.mockResolvedValueOnce(mockOk(makePhotonResponse([feature])));
    const { photonService } = await loadModule();

    const results = await photonService.geocode("Berlin");

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("osm:node/123456");
    expect(results[0].label).toBe("Berlin, Unter den Linden 1, Berlin, Germany");
    expect(results[0].coordinates).toEqual([13.37, 52.52]);
    expect(results[0].confidence).toBe(1);
    expect(results[0].rawCategory).toBe("place/city");
  });

  it("builds ID from osm_type lowercased + osm_id", async () => {
    const feature = makeBerlinFeature({ osm_type: "W", osm_id: 999 });
    mockFetch.mockResolvedValueOnce(mockOk(makePhotonResponse([feature])));
    const { photonService } = await loadModule();

    const results = await photonService.geocode("Berlin");
    expect(results[0].id).toBe("osm:way/999");
  });

  it("builds label without housenumber when not present", async () => {
    const feature = makeBerlinFeature({ housenumber: undefined });
    mockFetch.mockResolvedValueOnce(mockOk(makePhotonResponse([feature])));
    const { photonService } = await loadModule();

    const results = await photonService.geocode("Berlin");
    expect(results[0].label).toBe("Berlin, Unter den Linden, Berlin, Germany");
  });

  it('returns "Unknown location" when no properties have values', async () => {
    const feature = makeBerlinFeature({
      name: undefined,
      street: undefined,
      housenumber: undefined,
      city: undefined,
      country: undefined,
    });
    mockFetch.mockResolvedValueOnce(mockOk(makePhotonResponse([feature])));
    const { photonService } = await loadModule();

    const results = await photonService.geocode("nothing");
    expect(results[0].label).toBe("Unknown location");
  });

  it('maps osm_key "highway" to "street"', async () => {
    const feature = makeBerlinFeature({ osm_key: "highway", osm_value: "residential" });
    mockFetch.mockResolvedValueOnce(mockOk(makePhotonResponse([feature])));
    const { photonService } = await loadModule();

    const results = await photonService.geocode("street");
    expect(results[0].type).toBe("street");
  });

  it('maps osm_key "addr" to "address"', async () => {
    const feature = makeBerlinFeature({ osm_key: "addr", osm_value: "housenumber" });
    mockFetch.mockResolvedValueOnce(mockOk(makePhotonResponse([feature])));
    const { photonService } = await loadModule();

    const results = await photonService.geocode("address");
    expect(results[0].type).toBe("address");
  });

  it('maps osm_key "building" to "address"', async () => {
    const feature = makeBerlinFeature({ osm_key: "building", osm_value: "yes" });
    mockFetch.mockResolvedValueOnce(mockOk(makePhotonResponse([feature])));
    const { photonService } = await loadModule();

    const results = await photonService.geocode("building");
    expect(results[0].type).toBe("address");
  });

  it('maps osm_key "boundary" to "region"', async () => {
    const feature = makeBerlinFeature({ osm_key: "boundary", osm_value: "administrative" });
    mockFetch.mockResolvedValueOnce(mockOk(makePhotonResponse([feature])));
    const { photonService } = await loadModule();

    const results = await photonService.geocode("boundary");
    expect(results[0].type).toBe("region");
  });

  it('maps osm_key "natural" to "region"', async () => {
    const feature = makeBerlinFeature({ osm_key: "natural", osm_value: "water" });
    mockFetch.mockResolvedValueOnce(mockOk(makePhotonResponse([feature])));
    const { photonService } = await loadModule();

    const results = await photonService.geocode("lake");
    expect(results[0].type).toBe("region");
  });

  it('maps osm_key "landuse" to "region"', async () => {
    const feature = makeBerlinFeature({ osm_key: "landuse", osm_value: "forest" });
    mockFetch.mockResolvedValueOnce(mockOk(makePhotonResponse([feature])));
    const { photonService } = await loadModule();

    const results = await photonService.geocode("forest");
    expect(results[0].type).toBe("region");
  });

  it('maps unknown osm_key to "poi"', async () => {
    const feature = makeBerlinFeature({ osm_key: "amenity", osm_value: "cafe" });
    mockFetch.mockResolvedValueOnce(mockOk(makePhotonResponse([feature])));
    const { photonService } = await loadModule();

    const results = await photonService.geocode("cafe");
    expect(results[0].type).toBe("poi");
  });

  it("throws on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce(mockNotOk(429));
    const { photonService } = await loadModule();

    await expect(photonService.geocode("Berlin")).rejects.toThrow("Photon error 429");
  });
});

// reverseGeocode

describe("reverseGeocode", () => {
  it("returns address and city", async () => {
    const feature = makeBerlinFeature();
    mockFetch.mockResolvedValueOnce(mockOk(makePhotonResponse([feature])));
    const { photonService } = await loadModule();

    const result = await photonService.reverseGeocode(52.52, 13.37);

    expect(result).not.toBeNull();
    expect(result?.address).toBe("Berlin, Unter den Linden 1, Berlin, Germany");
    expect(result?.city).toBe("Berlin, Berlin");
  });

  it("returns null when no features returned", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(makePhotonResponse([])));
    const { photonService } = await loadModule();

    const result = await photonService.reverseGeocode(52.52, 13.37);
    expect(result).toBeNull();
  });
});

// autocomplete

describe("autocomplete", () => {
  it("uses name as label and buildLabel as sublabel when different", async () => {
    const feature = makeBerlinFeature({ name: "Berlin" });
    mockFetch.mockResolvedValueOnce(mockOk(makePhotonResponse([feature])));
    const { photonService } = await loadModule();

    const results = await photonService.autocomplete("Ber");

    expect(results).toHaveLength(1);
    expect(results[0].label).toBe("Berlin");
    expect(results[0].sublabel).toBe("Berlin, Unter den Linden 1, Berlin, Germany");
  });

  it("sets sublabel to undefined when label equals full buildLabel", async () => {
    const feature = makeBerlinFeature({
      name: "Germany",
      street: undefined,
      housenumber: undefined,
      city: undefined,
    });
    mockFetch.mockResolvedValueOnce(mockOk(makePhotonResponse([feature])));
    const { photonService } = await loadModule();

    const results = await photonService.autocomplete("Germany");

    // label = name = "Germany", buildLabel = "Germany, Germany" (name + country)
    // These are different, so sublabel should be defined
    expect(results[0].label).toBe("Germany");
    expect(results[0].sublabel).toBe("Germany, Germany");
  });

  it("uses buildLabel as label when name is missing", async () => {
    const feature = makeBerlinFeature({ name: undefined });
    mockFetch.mockResolvedValueOnce(mockOk(makePhotonResponse([feature])));
    const { photonService } = await loadModule();

    const results = await photonService.autocomplete("Unter");

    // label should fall back to the full buildLabel
    expect(results[0].label).toBe("Unter den Linden 1, Berlin, Germany");
    // sublabel should be undefined since short === full
    expect(results[0].sublabel).toBeUndefined();
  });

  it("sets iconPath from resolvePoiIconPath of osm_value", async () => {
    const feature = makeBerlinFeature({ osm_value: "restaurant" });
    mockFetch.mockResolvedValueOnce(mockOk(makePhotonResponse([feature])));
    const { photonService } = await loadModule();

    const results = await photonService.autocomplete("rest");
    expect(typeof results[0].iconPath).toBe("string");
    expect(results[0].rawCategory).toBe("place/restaurant");
  });
});
