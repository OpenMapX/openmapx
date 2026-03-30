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

function makePeliasResponse(features: unknown[]) {
  return { features };
}

function makeBerlinFeature(overrides: Record<string, unknown> = {}) {
  return {
    geometry: { coordinates: [13.37, 52.52] },
    properties: {
      gid: "whosonfirst:locality:101748799",
      label: "Berlin, Germany",
      name: "Berlin",
      layer: "locality",
      confidence: 0.95,
      locality: "Berlin",
      region: "Brandenburg",
      country: "Germany",
      ...overrides,
    },
  };
}

async function loadModule() {
  vi.resetModules();
  return import("@integrations/geocoding-pelias/provider.js");
}

// geocode

describe("geocode", () => {
  it("maps all fields from a feature correctly", async () => {
    const feature = makeBerlinFeature();
    mockFetch.mockResolvedValueOnce(mockOk(makePeliasResponse([feature])));
    const { peliasService } = await loadModule();

    const results = await peliasService.geocode("Berlin");

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("whosonfirst:locality:101748799");
    expect(results[0].label).toBe("Berlin, Germany");
    expect(results[0].coordinates).toEqual([13.37, 52.52]);
    expect(results[0].type).toBe("region");
    expect(results[0].confidence).toBe(0.95);
  });

  it('maps layer "venue" to "poi"', async () => {
    const feature = makeBerlinFeature({ layer: "venue" });
    mockFetch.mockResolvedValueOnce(mockOk(makePeliasResponse([feature])));
    const { peliasService } = await loadModule();

    const results = await peliasService.geocode("cafe");
    expect(results[0].type).toBe("poi");
  });

  it('maps layer "address" to "address"', async () => {
    const feature = makeBerlinFeature({ layer: "address" });
    mockFetch.mockResolvedValueOnce(mockOk(makePeliasResponse([feature])));
    const { peliasService } = await loadModule();

    const results = await peliasService.geocode("Alexanderplatz 1");
    expect(results[0].type).toBe("address");
  });

  it('maps layer "street" to "street"', async () => {
    const feature = makeBerlinFeature({ layer: "street" });
    mockFetch.mockResolvedValueOnce(mockOk(makePeliasResponse([feature])));
    const { peliasService } = await loadModule();

    const results = await peliasService.geocode("Karl-Marx-Allee");
    expect(results[0].type).toBe("street");
  });

  it('maps region-type layers to "region"', async () => {
    for (const layer of ["locality", "localadmin", "county", "region", "country", "continent"]) {
      vi.resetModules();
      mockFetch.mockResolvedValueOnce(mockOk(makePeliasResponse([makeBerlinFeature({ layer })])));
      const { peliasService } = await loadModule();

      const results = await peliasService.geocode("Berlin");
      expect(results[0].type).toBe("region");
    }
  });

  it('maps unknown layer to "poi"', async () => {
    const feature = makeBerlinFeature({ layer: "unknown_thing" });
    mockFetch.mockResolvedValueOnce(mockOk(makePeliasResponse([feature])));
    const { peliasService } = await loadModule();

    const results = await peliasService.geocode("what");
    expect(results[0].type).toBe("poi");
  });

  it("sends lang param only when provided", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(makePeliasResponse([])));
    const { peliasService } = await loadModule();

    await peliasService.geocode("Berlin", "de");

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get("lang")).toBe("de");
  });

  it("does not send lang param when not provided", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(makePeliasResponse([])));
    const { peliasService } = await loadModule();

    await peliasService.geocode("Berlin");

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.has("lang")).toBe(false);
  });

  it("throws on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce(mockNotOk(502));
    const { peliasService } = await loadModule();

    await expect(peliasService.geocode("Berlin")).rejects.toThrow("Pelias error 502");
  });
});

// reverseGeocode

describe("reverseGeocode", () => {
  it("builds city from locality and region", async () => {
    const feature = makeBerlinFeature({ locality: "Berlin", region: "Brandenburg" });
    mockFetch.mockResolvedValueOnce(mockOk(makePeliasResponse([feature])));
    const { peliasService } = await loadModule();

    const result = await peliasService.reverseGeocode(52.52, 13.37);

    expect(result).not.toBeNull();
    expect(result?.address).toBe("Berlin, Germany");
    expect(result?.city).toBe("Berlin, Brandenburg");
  });

  it("returns city with only locality when region is missing", async () => {
    const feature = makeBerlinFeature({ locality: "London", region: undefined });
    mockFetch.mockResolvedValueOnce(mockOk(makePeliasResponse([feature])));
    const { peliasService } = await loadModule();

    const result = await peliasService.reverseGeocode(51.5, -0.1);
    expect(result?.city).toBe("London");
  });

  it("returns null when no features returned", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(makePeliasResponse([])));
    const { peliasService } = await loadModule();

    const result = await peliasService.reverseGeocode(52.52, 13.37);
    expect(result).toBeNull();
  });

  it("sends lang to reverse endpoint", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(makePeliasResponse([])));
    const { peliasService } = await loadModule();

    await peliasService.reverseGeocode(52.52, 13.37, "fr");

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get("lang")).toBe("fr");
    expect(url.searchParams.get("point.lat")).toBe("52.52");
    expect(url.searchParams.get("point.lon")).toBe("13.37");
  });
});

// autocomplete

describe("autocomplete", () => {
  it("builds sublabel from locality, region, country", async () => {
    const feature = makeBerlinFeature({
      name: "Brandenburger Tor",
      locality: "Berlin",
      region: "Berlin",
      country: "Germany",
    });
    mockFetch.mockResolvedValueOnce(mockOk(makePeliasResponse([feature])));
    const { peliasService } = await loadModule();

    const results = await peliasService.autocomplete("Brandenburg");

    expect(results).toHaveLength(1);
    expect(results[0].label).toBe("Brandenburger Tor");
    expect(results[0].sublabel).toBe("Berlin, Berlin, Germany");
  });

  it("returns undefined sublabel when no locality/region/country", async () => {
    const feature = makeBerlinFeature({
      name: "Antarctica",
      locality: undefined,
      region: undefined,
      country: undefined,
    });
    mockFetch.mockResolvedValueOnce(mockOk(makePeliasResponse([feature])));
    const { peliasService } = await loadModule();

    const results = await peliasService.autocomplete("Ant");
    expect(results[0].sublabel).toBeUndefined();
  });

  it("filters out falsy parts from sublabel", async () => {
    const feature = makeBerlinFeature({
      name: "London",
      locality: "London",
      region: undefined,
      country: "United Kingdom",
    });
    mockFetch.mockResolvedValueOnce(mockOk(makePeliasResponse([feature])));
    const { peliasService } = await loadModule();

    const results = await peliasService.autocomplete("Lond");
    expect(results[0].sublabel).toBe("London, United Kingdom");
  });

  it("uses gid as id", async () => {
    const feature = makeBerlinFeature({ gid: "pelias:venue:12345" });
    mockFetch.mockResolvedValueOnce(mockOk(makePeliasResponse([feature])));
    const { peliasService } = await loadModule();

    const results = await peliasService.autocomplete("Berlin");
    expect(results[0].id).toBe("pelias:venue:12345");
  });
});
