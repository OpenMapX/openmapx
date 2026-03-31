import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetIntegrationsByDomain = vi.fn();

vi.mock("../../integration-host.js", () => ({
  getIntegrationsByDomain: mockGetIntegrationsByDomain,
}));

function mockProvider() {
  return {
    geocode: vi.fn(),
    autocomplete: vi.fn(),
    reverseGeocode: vi.fn(),
  };
}

const maptilerProvider = mockProvider();
const photonProvider = mockProvider();
const motisProvider = mockProvider();
const nominatimProvider = mockProvider();

function makeIntegration(id: string, provider: unknown) {
  return {
    id,
    enabled: true,
    manifest: { domains: ["geocoding"] },
    providers: new Map([["geocoding", [provider]]]),
  };
}

function setupIntegrations() {
  mockGetIntegrationsByDomain.mockReturnValue([
    makeIntegration("geocoding-maptiler", maptilerProvider),
    makeIntegration("geocoding-photon", photonProvider),
    makeIntegration("geocoding-motis", motisProvider),
    makeIntegration("geocoding-nominatim", nominatimProvider),
  ]);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  delete process.env.GEOCODING_PROVIDER;
  setupIntegrations();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GEOCODING_PROVIDER;
});

function makeSearchResult(label: string) {
  return {
    id: `id-${label}`,
    label,
    coordinates: [13.37, 52.52] as [number, number],
    type: "poi" as const,
    confidence: 0.9,
  };
}

function makeReverseResult(address: string) {
  return { address, city: "Berlin" };
}

async function setupChain(providerEnv: string) {
  vi.clearAllMocks();
  setupIntegrations();
  process.env.GEOCODING_PROVIDER = providerEnv;
  const { getGeocodingProvider } = await import("../geocoding.factory.js");
  return { getGeocodingProvider, photon: photonProvider, maptiler: maptilerProvider };
}

describe("getGeocodingProvider", () => {
  it("defaults to maptiler when GEOCODING_PROVIDER is not set", async () => {
    const { getGeocodingProvider } = await import("../geocoding.factory.js");
    maptilerProvider.geocode.mockResolvedValueOnce([makeSearchResult("maptiler-result")]);

    const provider = getGeocodingProvider();
    const results = await provider.geocode("Berlin");

    expect(results).toHaveLength(1);
    expect(results[0].label).toBe("maptiler-result");
  });

  it("returns single provider directly when only one configured", async () => {
    process.env.GEOCODING_PROVIDER = "photon";
    const { getGeocodingProvider } = await import("../geocoding.factory.js");
    photonProvider.geocode.mockResolvedValueOnce([makeSearchResult("photon-result")]);

    const provider = getGeocodingProvider();
    const results = await provider.geocode("Berlin");

    expect(results).toHaveLength(1);
    expect(results[0].label).toBe("photon-result");
  });

  it('"transitous" maps to motis provider', async () => {
    process.env.GEOCODING_PROVIDER = "transitous";
    const { getGeocodingProvider } = await import("../geocoding.factory.js");
    motisProvider.geocode.mockResolvedValueOnce([makeSearchResult("transitous-result")]);

    const provider = getGeocodingProvider();
    const results = await provider.geocode("test");

    expect(motisProvider.geocode).toHaveBeenCalled();
    expect(results[0].label).toBe("transitous-result");
  });

  it("throws descriptive error for unknown provider name", async () => {
    process.env.GEOCODING_PROVIDER = "google";

    await expect(
      import("../geocoding.factory.js").then((m) => m.getGeocodingProvider()),
    ).rejects.toThrow(/Unknown GEOCODING_PROVIDER: "google"/);
  });
});

describe("chain: geocode", () => {
  it("first non-empty result wins, second provider not called", async () => {
    const { getGeocodingProvider, photon, maptiler } = await setupChain("photon,maptiler");
    photon.geocode.mockResolvedValueOnce([makeSearchResult("photon-hit")]);

    const provider = getGeocodingProvider();
    const results = await provider.geocode("Berlin");

    expect(results[0].label).toBe("photon-hit");
    expect(maptiler.geocode).not.toHaveBeenCalled();
  });

  it("tries second provider when first returns empty array", async () => {
    const { getGeocodingProvider, photon, maptiler } = await setupChain("photon,maptiler");
    photon.geocode.mockResolvedValueOnce([]);
    maptiler.geocode.mockResolvedValueOnce([makeSearchResult("maptiler-fallback")]);

    const provider = getGeocodingProvider();
    const results = await provider.geocode("Berlin");

    expect(results[0].label).toBe("maptiler-fallback");
  });

  it("tries second provider when first throws", async () => {
    const { getGeocodingProvider, photon, maptiler } = await setupChain("photon,maptiler");
    photon.geocode.mockRejectedValueOnce(new Error("Photon down"));
    maptiler.geocode.mockResolvedValueOnce([makeSearchResult("maptiler-rescue")]);

    const provider = getGeocodingProvider();
    const results = await provider.geocode("Berlin");

    expect(results[0].label).toBe("maptiler-rescue");
  });

  it("re-throws when LAST provider throws", async () => {
    const { getGeocodingProvider, photon, maptiler } = await setupChain("photon,maptiler");
    photon.geocode.mockRejectedValueOnce(new Error("Photon down"));
    maptiler.geocode.mockRejectedValueOnce(new Error("MapTiler also down"));

    const provider = getGeocodingProvider();
    await expect(provider.geocode("Berlin")).rejects.toThrow("MapTiler also down");
  });

  it("returns empty array when all providers return empty", async () => {
    const { getGeocodingProvider, photon, maptiler } = await setupChain("photon,maptiler");
    photon.geocode.mockResolvedValueOnce([]);
    maptiler.geocode.mockResolvedValueOnce([]);

    const provider = getGeocodingProvider();
    const results = await provider.geocode("nothing");

    expect(results).toEqual([]);
  });
});

describe("chain: reverseGeocode", () => {
  it("tries second provider when first returns null", async () => {
    const { getGeocodingProvider, photon, maptiler } = await setupChain("photon,maptiler");
    photon.reverseGeocode.mockResolvedValueOnce(null);
    maptiler.reverseGeocode.mockResolvedValueOnce(makeReverseResult("MapTiler Address"));

    const provider = getGeocodingProvider();
    const result = await provider.reverseGeocode(52.52, 13.37);

    expect(result).not.toBeNull();
    expect(result?.address).toBe("MapTiler Address");
  });

  it("returns first non-null reverse result", async () => {
    const { getGeocodingProvider, photon, maptiler } = await setupChain("photon,maptiler");
    photon.reverseGeocode.mockResolvedValueOnce(makeReverseResult("Photon Address"));

    const provider = getGeocodingProvider();
    const result = await provider.reverseGeocode(52.52, 13.37);

    expect(result?.address).toBe("Photon Address");
    expect(maptiler.reverseGeocode).not.toHaveBeenCalled();
  });

  it("returns null when all providers return null", async () => {
    const { getGeocodingProvider, photon, maptiler } = await setupChain("photon,maptiler");
    photon.reverseGeocode.mockResolvedValueOnce(null);
    maptiler.reverseGeocode.mockResolvedValueOnce(null);

    const provider = getGeocodingProvider();
    const result = await provider.reverseGeocode(52.52, 13.37);

    expect(result).toBeNull();
  });

  it("catches error from non-last provider and tries next", async () => {
    const { getGeocodingProvider, photon, maptiler } = await setupChain("photon,maptiler");
    photon.reverseGeocode.mockRejectedValueOnce(new Error("Photon exploded"));
    maptiler.reverseGeocode.mockResolvedValueOnce(makeReverseResult("Saved by MapTiler"));

    const provider = getGeocodingProvider();
    const result = await provider.reverseGeocode(52.52, 13.37);

    expect(result?.address).toBe("Saved by MapTiler");
  });
});

describe("chain: autocomplete", () => {
  it("first non-empty autocomplete result wins", async () => {
    const { getGeocodingProvider, photon } = await setupChain("photon,maptiler");
    photon.autocomplete.mockResolvedValueOnce([
      { id: "1", label: "Berlin", coordinates: [13.37, 52.52], type: "region" as const },
    ]);

    const provider = getGeocodingProvider();
    const results = await provider.autocomplete("Ber");

    expect(results).toHaveLength(1);
    expect(results[0].label).toBe("Berlin");
  });

  it("falls through on empty autocomplete", async () => {
    const { getGeocodingProvider, photon, maptiler } = await setupChain("photon,maptiler");
    photon.autocomplete.mockResolvedValueOnce([]);
    maptiler.autocomplete.mockResolvedValueOnce([
      { id: "2", label: "Berlin Hbf", coordinates: [13.37, 52.52], type: "poi" as const },
    ]);

    const provider = getGeocodingProvider();
    const results = await provider.autocomplete("Berlin");

    expect(results[0].label).toBe("Berlin Hbf");
  });
});
