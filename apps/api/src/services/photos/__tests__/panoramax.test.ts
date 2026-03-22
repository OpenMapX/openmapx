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

function makeFeature(overrides: Record<string, unknown> = {}) {
  return {
    id: "feat-123",
    geometry: { type: "Point", coordinates: [2.35, 48.85] },
    properties: {
      datetime: "2023-11-14T10:00:00Z",
      license: "CC-BY-SA-4.0",
      providers: [{ name: "TestAuthor" }],
    },
    assets: {
      sd: { href: "https://panoramax.xyz/sd/123.jpg" },
      hd: { href: "https://panoramax.xyz/hd/123.jpg" },
      thumb: { href: "https://panoramax.xyz/thumb/123.jpg" },
    },
    links: [{ rel: "license", href: "https://creativecommons.org/licenses/by-sa/4.0/" }],
    ...overrides,
  };
}

async function loadModule() {
  return import("../panoramax.provider.js");
}

describe("panoramaxPhotoProvider", () => {
  describe("URL priority", () => {
    it("uses assets.sd.href when available", async () => {
      const { panoramaxPhotoProvider } = await loadModule();
      mockFetch.mockResolvedValue(mockOk({ type: "FeatureCollection", features: [makeFeature()] }));

      const results = await panoramaxPhotoProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results[0].url).toBe("https://panoramax.xyz/sd/123.jpg");
    });

    it("falls back to assets.hd.href when sd is missing", async () => {
      const { panoramaxPhotoProvider } = await loadModule();
      mockFetch.mockResolvedValue(
        mockOk({
          type: "FeatureCollection",
          features: [
            makeFeature({
              assets: {
                hd: { href: "https://panoramax.xyz/hd/456.jpg" },
                thumb: { href: "https://panoramax.xyz/thumb/456.jpg" },
              },
            }),
          ],
        }),
      );

      const results = await panoramaxPhotoProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results[0].url).toBe("https://panoramax.xyz/hd/456.jpg");
    });

    it("falls back to assets.thumb.href when sd and hd are missing", async () => {
      const { panoramaxPhotoProvider } = await loadModule();
      mockFetch.mockResolvedValue(
        mockOk({
          type: "FeatureCollection",
          features: [
            makeFeature({
              assets: {
                thumb: { href: "https://panoramax.xyz/thumb/789.jpg" },
              },
            }),
          ],
        }),
      );

      const results = await panoramaxPhotoProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results[0].url).toBe("https://panoramax.xyz/thumb/789.jpg");
    });
  });

  describe("filtering", () => {
    it("filters out features without sd or thumb assets", async () => {
      const { panoramaxPhotoProvider } = await loadModule();
      mockFetch.mockResolvedValue(
        mockOk({
          type: "FeatureCollection",
          features: [
            makeFeature({
              id: "good",
              assets: {
                sd: { href: "https://example.com/sd.jpg" },
                thumb: { href: "https://example.com/thumb.jpg" },
              },
            }),
            makeFeature({
              id: "bad-hd-only",
              assets: { hd: { href: "https://example.com/hd.jpg" } },
            }),
            makeFeature({ id: "bad-empty", assets: {} }),
          ],
        }),
      );

      const results = await panoramaxPhotoProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results).toHaveLength(1);
      expect(results[0].pageUrl).toContain("good");
    });
  });

  describe("SPDX license conversion", () => {
    it("converts 'CC-BY-SA-4.0' to 'CC BY-SA 4.0'", async () => {
      const { panoramaxPhotoProvider } = await loadModule();
      mockFetch.mockResolvedValue(
        mockOk({
          type: "FeatureCollection",
          features: [
            makeFeature({
              properties: { license: "CC-BY-SA-4.0", providers: [{ name: "Author" }] },
            }),
          ],
        }),
      );

      const results = await panoramaxPhotoProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results[0].license).toBe("CC BY-SA 4.0");
    });

    it("converts 'CC-BY-4.0' to 'CC BY 4.0'", async () => {
      const { panoramaxPhotoProvider } = await loadModule();
      mockFetch.mockResolvedValue(
        mockOk({
          type: "FeatureCollection",
          features: [
            makeFeature({
              properties: { license: "CC-BY-4.0", providers: [{ name: "Author" }] },
            }),
          ],
        }),
      );

      const results = await panoramaxPhotoProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results[0].license).toBe("CC BY 4.0");
    });

    it("defaults to 'CC-BY-SA-4.0' when license is missing", async () => {
      const { panoramaxPhotoProvider } = await loadModule();
      mockFetch.mockResolvedValue(
        mockOk({
          type: "FeatureCollection",
          features: [
            makeFeature({
              properties: { providers: [{ name: "Author" }] },
            }),
          ],
        }),
      );

      const results = await panoramaxPhotoProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results[0].license).toBe("CC BY-SA 4.0");
    });
  });

  describe("author extraction", () => {
    it("uses properties.providers[0].name as author", async () => {
      const { panoramaxPhotoProvider } = await loadModule();
      mockFetch.mockResolvedValue(
        mockOk({
          type: "FeatureCollection",
          features: [
            makeFeature({
              properties: {
                license: "CC-BY-SA-4.0",
                providers: [{ name: "Alice" }],
              },
            }),
          ],
        }),
      );

      const results = await panoramaxPhotoProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results[0].author).toBe("Alice");
      expect(results[0].attribution).toBe("Alice / Panoramax (CC BY-SA 4.0)");
    });

    it("falls back to geovisio:producer.name", async () => {
      const { panoramaxPhotoProvider } = await loadModule();
      mockFetch.mockResolvedValue(
        mockOk({
          type: "FeatureCollection",
          features: [
            makeFeature({
              properties: {
                license: "CC-BY-SA-4.0",
                providers: [],
                "geovisio:producer": { name: "Bob" },
              },
            }),
          ],
        }),
      );

      const results = await panoramaxPhotoProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results[0].author).toBe("Bob");
      expect(results[0].attribution).toBe("Bob / Panoramax (CC BY-SA 4.0)");
    });

    it("uses 'Panoramax (license)' when no author available", async () => {
      const { panoramaxPhotoProvider } = await loadModule();
      mockFetch.mockResolvedValue(
        mockOk({
          type: "FeatureCollection",
          features: [
            makeFeature({
              properties: {
                license: "CC-BY-SA-4.0",
                providers: [],
              },
            }),
          ],
        }),
      );

      const results = await panoramaxPhotoProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results[0].author).toBeUndefined();
      expect(results[0].attribution).toBe("Panoramax (CC BY-SA 4.0)");
    });
  });

  it("builds correct pageUrl with feature id", async () => {
    const { panoramaxPhotoProvider } = await loadModule();
    mockFetch.mockResolvedValue(
      mockOk({
        type: "FeatureCollection",
        features: [makeFeature({ id: "abc-def-123" })],
      }),
    );

    const results = await panoramaxPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results[0].pageUrl).toBe("https://panoramax.xyz/#focus=pic&pic=abc-def-123");
  });

  it("sets pageUrl to undefined when feature has no id", async () => {
    const { panoramaxPhotoProvider } = await loadModule();
    mockFetch.mockResolvedValue(
      mockOk({
        type: "FeatureCollection",
        features: [makeFeature({ id: undefined })],
      }),
    );

    const results = await panoramaxPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results[0].pageUrl).toBeUndefined();
  });

  it("returns [] on HTTP error", async () => {
    const { panoramaxPhotoProvider } = await loadModule();
    mockFetch.mockResolvedValue(mockNotOk(500));

    const results = await panoramaxPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results).toEqual([]);
  });

  it("returns [] on network error (fetch throws)", async () => {
    const { panoramaxPhotoProvider } = await loadModule();
    mockFetch.mockRejectedValue(new Error("Network error"));

    const results = await panoramaxPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results).toEqual([]);
  });

  it("returns [] when features array is empty", async () => {
    const { panoramaxPhotoProvider } = await loadModule();
    mockFetch.mockResolvedValue(mockOk({ type: "FeatureCollection", features: [] }));

    const results = await panoramaxPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results).toEqual([]);
  });

  it("returns [] when features is undefined", async () => {
    const { panoramaxPhotoProvider } = await loadModule();
    mockFetch.mockResolvedValue(mockOk({ type: "FeatureCollection" }));

    const results = await panoramaxPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results).toEqual([]);
  });

  it("sets thumbnailUrl from assets.thumb.href", async () => {
    const { panoramaxPhotoProvider } = await loadModule();
    mockFetch.mockResolvedValue(
      mockOk({
        type: "FeatureCollection",
        features: [makeFeature()],
      }),
    );

    const results = await panoramaxPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results[0].thumbnailUrl).toBe("https://panoramax.xyz/thumb/123.jpg");
  });

  it("sets coordinates from feature geometry", async () => {
    const { panoramaxPhotoProvider } = await loadModule();
    mockFetch.mockResolvedValue(
      mockOk({
        type: "FeatureCollection",
        features: [makeFeature({ geometry: { type: "Point", coordinates: [13.4, 52.52] } })],
      }),
    );

    const results = await panoramaxPhotoProvider.search({ lat: 52.52, lng: 13.4 });

    expect(results[0].coordinates).toEqual([13.4, 52.52]);
  });

  it("uses license link from feature links when available", async () => {
    const { panoramaxPhotoProvider } = await loadModule();
    mockFetch.mockResolvedValue(
      mockOk({
        type: "FeatureCollection",
        features: [
          makeFeature({
            links: [{ rel: "license", href: "https://example.com/custom-license" }],
          }),
        ],
      }),
    );

    const results = await panoramaxPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results[0].licenseUrl).toBe("https://example.com/custom-license");
  });
});
