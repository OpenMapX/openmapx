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

function makeBerlinResult(overrides: Record<string, unknown> = {}) {
  return {
    place_id: 42,
    osm_type: "node",
    osm_id: 123456,
    lat: "52.5200",
    lon: "13.3700",
    display_name: "Berlin, Germany",
    class: "place",
    type: "city",
    importance: 0.87,
    ...overrides,
  };
}

async function loadModule() {
  vi.resetModules();
  return import("../nominatim.service.js");
}

// geocode

describe("geocode", () => {
  it("parses lat/lon from strings and maps all fields", async () => {
    const result = makeBerlinResult();
    mockFetch.mockResolvedValueOnce(mockOk([result]));
    const { nominatimService } = await loadModule();

    const results = await nominatimService.geocode("Berlin");

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("node/123456");
    expect(results[0].label).toBe("Berlin, Germany");
    expect(results[0].coordinates).toEqual([13.37, 52.52]);
    expect(results[0].confidence).toBe(0.87);
    expect(results[0].rawCategory).toBe("place/city");
  });

  it("makes ID from osm_type/osm_id", async () => {
    const result = makeBerlinResult({ osm_type: "way", osm_id: 999 });
    mockFetch.mockResolvedValueOnce(mockOk([result]));
    const { nominatimService } = await loadModule();

    const results = await nominatimService.geocode("Berlin");
    expect(results[0].id).toBe("way/999");
  });

  it('maps class "highway" to "street"', async () => {
    const result = makeBerlinResult({ class: "highway", type: "residential" });
    mockFetch.mockResolvedValueOnce(mockOk([result]));
    const { nominatimService } = await loadModule();

    const results = await nominatimService.geocode("Berlin");
    expect(results[0].type).toBe("street");
  });

  it('maps class "place" + type "house" to "address"', async () => {
    const result = makeBerlinResult({ class: "place", type: "house" });
    mockFetch.mockResolvedValueOnce(mockOk([result]));
    const { nominatimService } = await loadModule();

    const results = await nominatimService.geocode("Berlin");
    expect(results[0].type).toBe("address");
  });

  it('maps class "amenity" to "poi"', async () => {
    const result = makeBerlinResult({ class: "amenity", type: "cafe" });
    mockFetch.mockResolvedValueOnce(mockOk([result]));
    const { nominatimService } = await loadModule();

    const results = await nominatimService.geocode("Berlin");
    expect(results[0].type).toBe("poi");
  });

  it('maps class "shop" to "poi"', async () => {
    const result = makeBerlinResult({ class: "shop", type: "supermarket" });
    mockFetch.mockResolvedValueOnce(mockOk([result]));
    const { nominatimService } = await loadModule();

    const results = await nominatimService.geocode("Berlin");
    expect(results[0].type).toBe("poi");
  });

  it('maps class "tourism" to "poi"', async () => {
    const result = makeBerlinResult({ class: "tourism", type: "museum" });
    mockFetch.mockResolvedValueOnce(mockOk([result]));
    const { nominatimService } = await loadModule();

    const results = await nominatimService.geocode("Berlin");
    expect(results[0].type).toBe("poi");
  });

  it('maps class "leisure" to "poi"', async () => {
    const result = makeBerlinResult({ class: "leisure", type: "park" });
    mockFetch.mockResolvedValueOnce(mockOk([result]));
    const { nominatimService } = await loadModule();

    const results = await nominatimService.geocode("Berlin");
    expect(results[0].type).toBe("poi");
  });

  it('maps unknown class to "region"', async () => {
    const result = makeBerlinResult({ class: "boundary", type: "administrative" });
    mockFetch.mockResolvedValueOnce(mockOk([result]));
    const { nominatimService } = await loadModule();

    const results = await nominatimService.geocode("Berlin");
    expect(results[0].type).toBe("region");
  });

  it("sends User-Agent and Accept-Language headers", async () => {
    mockFetch.mockResolvedValueOnce(mockOk([]));
    const { nominatimService } = await loadModule();

    await nominatimService.geocode("Berlin", "de");

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers["User-Agent"]).toBe("OpenMapX/1.0 (https://github.com/openmapx)");
    expect(options.headers["Accept-Language"]).toBe("de");
  });

  it("defaults Accept-Language to en when no lang provided", async () => {
    mockFetch.mockResolvedValueOnce(mockOk([]));
    const { nominatimService } = await loadModule();

    await nominatimService.geocode("Berlin");

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers["Accept-Language"]).toBe("en");
  });

  it("throws on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce(mockNotOk(503));
    const { nominatimService } = await loadModule();

    await expect(nominatimService.geocode("Berlin")).rejects.toThrow("Nominatim error 503");
  });
});

// reverseGeocode

describe("reverseGeocode", () => {
  it("builds address from house_number, road, city, postcode, country", async () => {
    const reverseResult = {
      display_name: "Alexanderplatz, Berlin, 10178, Germany",
      address: {
        house_number: "1",
        road: "Alexanderplatz",
        city: "Berlin",
        postcode: "10178",
        country: "Germany",
      },
    };
    mockFetch.mockResolvedValueOnce(mockOk(reverseResult));
    const { nominatimService } = await loadModule();

    const result = await nominatimService.reverseGeocode(52.52, 13.41);

    expect(result).not.toBeNull();
    expect(result?.address).toBe("1 Alexanderplatz, Berlin, 10178, Germany");
    expect(result?.city).toBe("Berlin");
  });

  it("falls back city from city to town to village", async () => {
    const reverseResult = {
      display_name: "Some Village, Germany",
      address: {
        village: "Dorfstadt",
        country: "Germany",
      },
    };
    mockFetch.mockResolvedValueOnce(mockOk(reverseResult));
    const { nominatimService } = await loadModule();

    const result = await nominatimService.reverseGeocode(52.0, 13.0);

    expect(result?.city).toContain("Dorfstadt");
  });

  it("falls back to display_name first part when no street info", async () => {
    const reverseResult = {
      display_name: "Brandenburg Gate, Berlin, Germany",
      address: {
        city: "Berlin",
        country: "Germany",
      },
    };
    mockFetch.mockResolvedValueOnce(mockOk(reverseResult));
    const { nominatimService } = await loadModule();

    const result = await nominatimService.reverseGeocode(52.52, 13.37);

    expect(result?.address).toBe("Brandenburg Gate, Berlin, Germany");
  });

  it("includes state or county in city field", async () => {
    const reverseResult = {
      display_name: "Somewhere, Berlin, Germany",
      address: {
        city: "Berlin",
        state: "Berlin",
        country: "Germany",
      },
    };
    mockFetch.mockResolvedValueOnce(mockOk(reverseResult));
    const { nominatimService } = await loadModule();

    const result = await nominatimService.reverseGeocode(52.52, 13.37);

    expect(result?.city).toBe("Berlin, Berlin");
  });

  it("returns null on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce(mockNotOk(500));
    const { nominatimService } = await loadModule();

    const result = await nominatimService.reverseGeocode(52.52, 13.37);
    expect(result).toBeNull();
  });

  it("returns null when response contains error field", async () => {
    const reverseResult = { display_name: "", error: "Unable to geocode" };
    mockFetch.mockResolvedValueOnce(mockOk(reverseResult));
    const { nominatimService } = await loadModule();

    const result = await nominatimService.reverseGeocode(52.52, 13.37);
    expect(result).toBeNull();
  });
});

// autocomplete

describe("autocomplete", () => {
  it("sets label to the first comma-separated part of display_name", async () => {
    const result = makeBerlinResult({ display_name: "Berlin, Germany" });
    mockFetch.mockResolvedValueOnce(mockOk([result]));
    const { nominatimService } = await loadModule();

    const results = await nominatimService.autocomplete("Ber");

    expect(results).toHaveLength(1);
    expect(results[0].label).toBe("Berlin");
    expect(results[0].sublabel).toBe("Berlin, Germany");
  });

  it("maps all fields correctly for autocomplete", async () => {
    const result = makeBerlinResult({ class: "amenity", type: "restaurant" });
    mockFetch.mockResolvedValueOnce(mockOk([result]));
    const { nominatimService } = await loadModule();

    const results = await nominatimService.autocomplete("restaurant");

    expect(results[0].id).toBe("node/123456");
    expect(results[0].coordinates).toEqual([13.37, 52.52]);
    expect(results[0].type).toBe("poi");
    expect(results[0].rawCategory).toBe("amenity/restaurant");
    expect(typeof results[0].iconPath).toBe("string");
  });
});
