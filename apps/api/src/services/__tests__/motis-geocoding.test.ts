import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockMotisGeocode = vi.fn();
const mockMotisReverseGeocode = vi.fn();
const mockUniqueModes = vi.fn();

vi.mock("@motis-project/motis-client", () => ({
  geocode: (...args: unknown[]) => mockMotisGeocode(...args),
  reverseGeocode: (...args: unknown[]) => mockMotisReverseGeocode(...args),
}));

vi.mock("../motis/instances.js", () => ({
  transitousInstance: {
    client: { baseUrl: "https://api.transitous.org" },
    prefix: "mo:",
    provider: "transitous",
  },
}));

vi.mock("../motis/mode-map.js", () => ({
  uniqueModes: (...args: unknown[]) => mockUniqueModes(...args),
}));

beforeEach(() => {
  mockMotisGeocode.mockReset();
  mockMotisReverseGeocode.mockReset();
  mockUniqueModes.mockReset();
  mockUniqueModes.mockReturnValue(["bus", "rail"]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeMatch(overrides: Record<string, unknown> = {}) {
  return {
    id: "mo:stop123",
    name: "Berlin Hauptbahnhof",
    lat: 52.52,
    lon: 13.37,
    type: "STOP",
    score: 85,
    category: "train_station",
    modes: ["RAIL", "SUBURBAN"],
    street: undefined,
    houseNumber: undefined,
    areas: [],
    ...overrides,
  };
}

async function loadModule() {
  return import("@integrations/geocoding-motis/provider.js");
}

// geocode

describe("geocode", () => {
  it('maps ADDRESS type to "address"', async () => {
    const match = makeMatch({ type: "ADDRESS", score: 90 });
    mockMotisGeocode.mockResolvedValueOnce({ data: [match] });
    const { motisGeocodingService } = await loadModule();

    const results = await motisGeocodingService.geocode("Berlin");

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("mo:stop123");
    expect(results[0].label).toBe("Berlin Hauptbahnhof");
    expect(results[0].coordinates).toEqual([13.37, 52.52]);
    expect(results[0].type).toBe("address");
    expect(results[0].confidence).toBe(0.9);
    expect(results[0].rawCategory).toBe("train_station");
  });

  it('maps non-ADDRESS type to "poi"', async () => {
    const match = makeMatch({ type: "STOP", score: 70 });
    mockMotisGeocode.mockResolvedValueOnce({ data: [match] });
    const { motisGeocodingService } = await loadModule();

    const results = await motisGeocodingService.geocode("Berlin");
    expect(results[0].type).toBe("poi");
    expect(results[0].confidence).toBe(0.7);
  });

  it("computes confidence as score / 100", async () => {
    const match = makeMatch({ score: 42 });
    mockMotisGeocode.mockResolvedValueOnce({ data: [match] });
    const { motisGeocodingService } = await loadModule();

    const results = await motisGeocodingService.geocode("test");
    expect(results[0].confidence).toBeCloseTo(0.42);
  });

  it("returns empty array on error", async () => {
    mockMotisGeocode.mockRejectedValueOnce(new Error("Network error"));
    const { motisGeocodingService } = await loadModule();

    const results = await motisGeocodingService.geocode("Berlin");
    expect(results).toEqual([]);
  });

  it("returns empty array when data is null", async () => {
    mockMotisGeocode.mockResolvedValueOnce({ data: null });
    const { motisGeocodingService } = await loadModule();

    const results = await motisGeocodingService.geocode("Berlin");
    expect(results).toEqual([]);
  });
});

// autocomplete

describe("autocomplete", () => {
  it('maps STOP type to "transit_stop" with transitStop object', async () => {
    const match = makeMatch({ type: "STOP", modes: ["RAIL", "BUS"] });
    mockMotisGeocode.mockResolvedValueOnce({ data: [match] });
    const { motisGeocodingService } = await loadModule();

    const results = await motisGeocodingService.autocomplete("Berlin");

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("transit_stop");
    expect(results[0].transitStop).toEqual({
      id: "mo:stop123",
      name: "Berlin Hauptbahnhof",
      lat: 52.52,
      lng: 13.37,
      modes: ["bus", "rail"],
      provider: "transitous",
    });
    expect(results[0].rawCategory).toBe("train_station");
  });

  it("calls uniqueModes with the match modes", async () => {
    const match = makeMatch({ modes: ["TRAM", "FERRY"] });
    mockMotisGeocode.mockResolvedValueOnce({ data: [match] });
    const { motisGeocodingService } = await loadModule();

    await motisGeocodingService.autocomplete("test");

    expect(mockUniqueModes).toHaveBeenCalledWith(["TRAM", "FERRY"]);
  });

  it('maps ADDRESS type to "address" in autocomplete', async () => {
    const match = makeMatch({ type: "ADDRESS" });
    mockMotisGeocode.mockResolvedValueOnce({ data: [match] });
    const { motisGeocodingService } = await loadModule();

    const results = await motisGeocodingService.autocomplete("Alexanderplatz 1");
    expect(results[0].type).toBe("address");
    expect(results[0].transitStop).toBeUndefined();
  });

  it('maps non-STOP non-ADDRESS type to "poi" in autocomplete', async () => {
    const match = makeMatch({ type: "PLACE" });
    mockMotisGeocode.mockResolvedValueOnce({ data: [match] });
    const { motisGeocodingService } = await loadModule();

    const results = await motisGeocodingService.autocomplete("park");
    expect(results[0].type).toBe("poi");
  });

  it("returns empty array on error", async () => {
    mockMotisGeocode.mockRejectedValueOnce(new Error("timeout"));
    const { motisGeocodingService } = await loadModule();

    const results = await motisGeocodingService.autocomplete("Berlin");
    expect(results).toEqual([]);
  });
});

// reverseGeocode

describe("reverseGeocode", () => {
  it("builds address from street + houseNumber", async () => {
    const match = makeMatch({
      street: "Unter den Linden",
      houseNumber: "1",
      areas: [{ name: "Berlin", default: true }],
    });
    mockMotisReverseGeocode.mockResolvedValueOnce({ data: [match] });
    const { motisGeocodingService } = await loadModule();

    const result = await motisGeocodingService.reverseGeocode(52.52, 13.37);

    expect(result).not.toBeNull();
    expect(result?.address).toBe("Unter den Linden 1");
    expect(result?.city).toBe("Berlin");
  });

  it("falls back to name when no street info", async () => {
    const match = makeMatch({
      name: "Brandenburg Gate",
      street: undefined,
      houseNumber: undefined,
      areas: [{ name: "Berlin", default: true }],
    });
    mockMotisReverseGeocode.mockResolvedValueOnce({ data: [match] });
    const { motisGeocodingService } = await loadModule();

    const result = await motisGeocodingService.reverseGeocode(52.52, 13.37);
    expect(result?.address).toBe("Brandenburg Gate");
  });

  it("resolves city from area with default=true", async () => {
    const match = makeMatch({
      areas: [
        { name: "Mitte", default: false },
        { name: "Berlin", default: true },
      ],
    });
    mockMotisReverseGeocode.mockResolvedValueOnce({ data: [match] });
    const { motisGeocodingService } = await loadModule();

    const result = await motisGeocodingService.reverseGeocode(52.52, 13.37);
    expect(result?.city).toBe("Berlin");
  });

  it("returns empty city when no default area", async () => {
    const match = makeMatch({
      areas: [{ name: "Mitte", default: false }],
    });
    mockMotisReverseGeocode.mockResolvedValueOnce({ data: [match] });
    const { motisGeocodingService } = await loadModule();

    const result = await motisGeocodingService.reverseGeocode(52.52, 13.37);
    expect(result?.city).toBe("");
  });

  it("returns null when no matches", async () => {
    mockMotisReverseGeocode.mockResolvedValueOnce({ data: [] });
    const { motisGeocodingService } = await loadModule();

    const result = await motisGeocodingService.reverseGeocode(52.52, 13.37);
    expect(result).toBeNull();
  });

  it("returns null when data is null", async () => {
    mockMotisReverseGeocode.mockResolvedValueOnce({ data: null });
    const { motisGeocodingService } = await loadModule();

    const result = await motisGeocodingService.reverseGeocode(52.52, 13.37);
    expect(result).toBeNull();
  });

  it("returns null on error", async () => {
    mockMotisReverseGeocode.mockRejectedValueOnce(new Error("server error"));
    const { motisGeocodingService } = await loadModule();

    const result = await motisGeocodingService.reverseGeocode(52.52, 13.37);
    expect(result).toBeNull();
  });
});
