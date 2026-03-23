import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../osm-label.js", () => ({
  resolveOsmLabel: vi.fn(() => "test-category"),
}));

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

// mockNotOk intentionally omitted — lookupByOsmRef throws on non-ok, tested via fetch rejection

function makeDetailResult(overrides: Record<string, unknown> = {}) {
  return {
    place_id: 42,
    osm_type: "node",
    osm_id: 123456,
    lat: "52.5200",
    lon: "13.3700",
    display_name: "Brandenburger Tor, Pariser Platz, Mitte, Berlin, 10117, Germany",
    class: "tourism",
    type: "attraction",
    address: {
      house_number: "1",
      road: "Pariser Platz",
      city: "Berlin",
      state: "Berlin",
      postcode: "10117",
      country: "Germany",
    },
    extratags: {
      phone: "+49 30 1234567",
      website: "https://example.com",
      opening_hours: "Mo-Su 09:00-18:00",
      wheelchair: "yes",
      wikidata: "Q82425",
    },
    ...overrides,
  };
}

async function loadModule() {
  vi.resetModules();
  return import("../nominatim-lookup.service.js");
}

// lookupByOsmRef

describe("lookupByOsmRef", () => {
  it("maps node to N prefix", async () => {
    mockFetch.mockResolvedValueOnce(mockOk([makeDetailResult()]));
    const { lookupByOsmRef } = await loadModule();

    await lookupByOsmRef("node", "123456", "original-id");

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get("osm_ids")).toBe("N123456");
  });

  it("maps way to W prefix", async () => {
    mockFetch.mockResolvedValueOnce(mockOk([makeDetailResult({ osm_type: "way" })]));
    const { lookupByOsmRef } = await loadModule();

    await lookupByOsmRef("way", "789", "original-id");

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get("osm_ids")).toBe("W789");
  });

  it("maps relation to R prefix", async () => {
    mockFetch.mockResolvedValueOnce(mockOk([makeDetailResult({ osm_type: "relation" })]));
    const { lookupByOsmRef } = await loadModule();

    await lookupByOsmRef("relation", "456", "original-id");

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get("osm_ids")).toBe("R456");
  });

  it("throws on unknown OSM type", async () => {
    const { lookupByOsmRef } = await loadModule();

    await expect(lookupByOsmRef("polygon", "123", "id")).rejects.toThrow(
      "Unknown OSM type: polygon",
    );
  });

  it("throws when no result found", async () => {
    mockFetch.mockResolvedValueOnce(mockOk([]));
    const { lookupByOsmRef } = await loadModule();

    await expect(lookupByOsmRef("node", "999", "id")).rejects.toThrow("Nominatim found no result");
  });
});

// toPlace (tested via lookupByOsmRef)

describe("toPlace mapping", () => {
  it("sets name to first comma part of display_name", async () => {
    mockFetch.mockResolvedValueOnce(mockOk([makeDetailResult()]));
    const { lookupByOsmRef } = await loadModule();

    const place = await lookupByOsmRef("node", "123456", "test-id");

    expect(place.name).toBe("Brandenburger Tor");
  });

  it("builds address from buildAddress helper", async () => {
    mockFetch.mockResolvedValueOnce(mockOk([makeDetailResult()]));
    const { lookupByOsmRef } = await loadModule();

    const place = await lookupByOsmRef("node", "123456", "test-id");

    expect(place.address).toBe("1 Pariser Platz, Berlin, 10117, Germany");
  });

  it("falls back city from city to town to village", async () => {
    const result = makeDetailResult({
      address: { town: "Potsdam", country: "Germany" },
    });
    mockFetch.mockResolvedValueOnce(mockOk([result]));
    const { lookupByOsmRef } = await loadModule();

    const place = await lookupByOsmRef("node", "123456", "test-id");
    expect(place.city).toBe("Potsdam");
  });

  it("falls back city to village when city and town missing", async () => {
    const result = makeDetailResult({
      address: { village: "Dorfstadt", country: "Germany" },
    });
    mockFetch.mockResolvedValueOnce(mockOk([result]));
    const { lookupByOsmRef } = await loadModule();

    const place = await lookupByOsmRef("node", "123456", "test-id");
    expect(place.city).toBe("Dorfstadt");
  });

  it("falls back city to county when city/town/village missing", async () => {
    const result = makeDetailResult({
      address: { county: "Oberbayern", country: "Germany" },
    });
    mockFetch.mockResolvedValueOnce(mockOk([result]));
    const { lookupByOsmRef } = await loadModule();

    const place = await lookupByOsmRef("node", "123456", "test-id");
    expect(place.city).toBe("Oberbayern");
  });

  it("extracts phone, website, opening_hours from extratags", async () => {
    mockFetch.mockResolvedValueOnce(mockOk([makeDetailResult()]));
    const { lookupByOsmRef } = await loadModule();

    const place = await lookupByOsmRef("node", "123456", "test-id");

    expect(place.phone).toBe("+49 30 1234567");
    expect(place.website).toBe("https://example.com");
    expect(place.openingHours).toBe("Mo-Su 09:00-18:00");
  });

  it("puts remaining extratags in osmTags", async () => {
    mockFetch.mockResolvedValueOnce(mockOk([makeDetailResult()]));
    const { lookupByOsmRef } = await loadModule();

    const place = await lookupByOsmRef("node", "123456", "test-id");

    expect(place.osmTags).toEqual({ wheelchair: "yes", wikidata: "Q82425" });
  });

  it("sets osmTags to undefined when no extra tags remain", async () => {
    const result = makeDetailResult({
      extratags: { phone: "+49 30 1234567", website: "https://example.com", opening_hours: "24/7" },
    });
    mockFetch.mockResolvedValueOnce(mockOk([result]));
    const { lookupByOsmRef } = await loadModule();

    const place = await lookupByOsmRef("node", "123456", "test-id");
    expect(place.osmTags).toBeUndefined();
  });

  it("sets osmTags to undefined when extratags is empty", async () => {
    const result = makeDetailResult({ extratags: {} });
    mockFetch.mockResolvedValueOnce(mockOk([result]));
    const { lookupByOsmRef } = await loadModule();

    const place = await lookupByOsmRef("node", "123456", "test-id");
    expect(place.osmTags).toBeUndefined();
  });

  it("uses resolveOsmLabel for category", async () => {
    mockFetch.mockResolvedValueOnce(mockOk([makeDetailResult()]));
    const { lookupByOsmRef } = await loadModule();

    const place = await lookupByOsmRef("node", "123456", "test-id");
    expect(place.category).toBe("test-category");
  });

  it("parses coordinates from string lat/lon", async () => {
    mockFetch.mockResolvedValueOnce(mockOk([makeDetailResult()]));
    const { lookupByOsmRef } = await loadModule();

    const place = await lookupByOsmRef("node", "123456", "test-id");
    expect(place.coordinates).toEqual([13.37, 52.52]);
  });

  it("uses originalId as place id", async () => {
    mockFetch.mockResolvedValueOnce(mockOk([makeDetailResult()]));
    const { lookupByOsmRef } = await loadModule();

    const place = await lookupByOsmRef("node", "123456", "my-custom-id");
    expect(place.id).toBe("my-custom-id");
  });
});

// lookupByNameAndCoords

describe("lookupByNameAndCoords", () => {
  it("returns closest result within 500m", async () => {
    const result = makeDetailResult({
      lat: "52.5201",
      lon: "13.3701",
    });
    mockFetch.mockResolvedValueOnce(mockOk([result]));
    const { lookupByNameAndCoords } = await loadModule();

    const place = await lookupByNameAndCoords("Brandenburger Tor", 52.52, 13.37, "id-1");

    expect(place).not.toBeNull();
    expect(place?.name).toBe("Brandenburger Tor");
  });

  it("returns null when result is too far (>500m)", async () => {
    // Place result ~50km away
    const result = makeDetailResult({
      lat: "53.0000",
      lon: "14.0000",
    });
    mockFetch.mockResolvedValueOnce(mockOk([result]));
    const { lookupByNameAndCoords } = await loadModule();

    const place = await lookupByNameAndCoords("Something", 52.52, 13.37, "id-1");
    expect(place).toBeNull();
  });

  it("returns null when no results found", async () => {
    mockFetch.mockResolvedValueOnce(mockOk([]));
    const { lookupByNameAndCoords } = await loadModule();

    const place = await lookupByNameAndCoords("Nowhere", 52.52, 13.37, "id-1");
    expect(place).toBeNull();
  });

  it("sends viewbox with correct bounding box (+-0.015 degrees)", async () => {
    mockFetch.mockResolvedValueOnce(mockOk([]));
    const { lookupByNameAndCoords } = await loadModule();

    await lookupByNameAndCoords("Berlin", 52.52, 13.37, "id-1");

    const url = new URL(mockFetch.mock.calls[0][0]);
    const viewbox = url.searchParams.get("viewbox");
    expect(viewbox).not.toBeNull();

    const parts = viewbox?.split(",").map(Number) ?? [];
    expect(parts[0]).toBeCloseTo(13.37 - 0.015, 3); // left = lng - BBOX_DEGREES
    expect(parts[1]).toBeCloseTo(52.52 + 0.015, 3); // top = lat + BBOX_DEGREES
    expect(parts[2]).toBeCloseTo(13.37 + 0.015, 3); // right = lng + BBOX_DEGREES
    expect(parts[3]).toBeCloseTo(52.52 - 0.015, 3); // bottom = lat - BBOX_DEGREES
  });

  it("picks the closest of multiple results", async () => {
    const far = makeDetailResult({
      lat: "52.5250",
      lon: "13.3750",
      display_name: "Far Place, Berlin",
    });
    const near = makeDetailResult({
      lat: "52.5201",
      lon: "13.3701",
      display_name: "Near Place, Berlin",
    });
    mockFetch.mockResolvedValueOnce(mockOk([far, near]));
    const { lookupByNameAndCoords } = await loadModule();

    const place = await lookupByNameAndCoords("Place", 52.52, 13.37, "id-1");
    expect(place).not.toBeNull();
    expect(place?.name).toBe("Near Place");
  });
});

// lookupByCoords

describe("lookupByCoords", () => {
  it("returns a Place on success", async () => {
    const result = makeDetailResult();
    mockFetch.mockResolvedValueOnce(mockOk(result));
    const { lookupByCoords } = await loadModule();

    const place = await lookupByCoords(52.52, 13.37, "coord-id");

    expect(place).not.toBeNull();
    expect(place?.id).toBe("coord-id");
    expect(place?.name).toBe("Brandenburger Tor");
  });

  it("returns null on error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    const { lookupByCoords } = await loadModule();

    const place = await lookupByCoords(52.52, 13.37, "coord-id");
    expect(place).toBeNull();
  });

  it("returns null when result has no osm_id", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ address: {} }));
    const { lookupByCoords } = await loadModule();

    const place = await lookupByCoords(52.52, 13.37, "coord-id");
    expect(place).toBeNull();
  });
});

// reverseGeocodeCity

describe("reverseGeocodeCity", () => {
  it("returns city name from address.city", async () => {
    const result = makeDetailResult();
    mockFetch.mockResolvedValueOnce(mockOk(result));
    const { reverseGeocodeCity } = await loadModule();

    const city = await reverseGeocodeCity(52.52, 13.37);
    expect(city).toBe("Berlin");
  });

  it("falls back to town when city is missing", async () => {
    const result = makeDetailResult({
      address: { town: "Potsdam", country: "Germany" },
    });
    mockFetch.mockResolvedValueOnce(mockOk(result));
    const { reverseGeocodeCity } = await loadModule();

    const city = await reverseGeocodeCity(52.0, 13.0);
    expect(city).toBe("Potsdam");
  });

  it("falls back to village when city and town missing", async () => {
    const result = makeDetailResult({
      address: { village: "Kleinstadt", country: "Germany" },
    });
    mockFetch.mockResolvedValueOnce(mockOk(result));
    const { reverseGeocodeCity } = await loadModule();

    const city = await reverseGeocodeCity(51.0, 12.0);
    expect(city).toBe("Kleinstadt");
  });

  it("returns null when no city/town/village found", async () => {
    const result = makeDetailResult({
      address: { country: "Germany" },
    });
    mockFetch.mockResolvedValueOnce(mockOk(result));
    const { reverseGeocodeCity } = await loadModule();

    const city = await reverseGeocodeCity(50.0, 11.0);
    expect(city).toBeNull();
  });

  it("caches by rounded coordinates and lang", async () => {
    const result = makeDetailResult();
    mockFetch.mockResolvedValue(mockOk(result));
    const { reverseGeocodeCity } = await loadModule();

    // First call hits fetch
    const city1 = await reverseGeocodeCity(52.52, 13.37, "en");
    expect(city1).toBe("Berlin");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call with nearby coords (same rounded value) should use cache
    const city2 = await reverseGeocodeCity(52.54, 13.39, "en");
    expect(city2).toBe("Berlin");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("treats different lang as separate cache key", async () => {
    const resultEn = makeDetailResult();
    const resultDe = makeDetailResult({
      address: { city: "Berlin", country: "Deutschland" },
    });
    mockFetch.mockResolvedValueOnce(mockOk(resultEn));
    mockFetch.mockResolvedValueOnce(mockOk(resultDe));
    const { reverseGeocodeCity } = await loadModule();

    await reverseGeocodeCity(52.52, 13.37, "en");
    await reverseGeocodeCity(52.52, 13.37, "de");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns null on error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    const { reverseGeocodeCity } = await loadModule();

    const city = await reverseGeocodeCity(52.52, 13.37);
    expect(city).toBeNull();
  });
});
