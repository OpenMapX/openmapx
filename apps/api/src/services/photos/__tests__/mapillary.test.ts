import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  vi.stubEnv("MAPILLARY_TOKEN", "test-token");
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

function makeImage(overrides: Record<string, unknown> = {}) {
  return {
    id: "123456",
    geometry: { type: "Point", coordinates: [2.35, 48.85] },
    thumb_1024_url: "https://scontent.mapillary.com/123456/thumb-1024.jpg",
    thumb_256_url: "https://scontent.mapillary.com/123456/thumb-256.jpg",
    captured_at: 1700000000000,
    creator: { username: "testuser" },
    is_pano: false,
    ...overrides,
  };
}

async function loadModule() {
  return import("@integrations/photos-mapillary/provider.js");
}

describe("mapillaryPhotoProvider", () => {
  it("filters out panoramic images (is_pano: true)", async () => {
    const { mapillaryPhotoProvider } = await loadModule();
    mockFetch.mockResolvedValue(
      mockOk({
        data: [
          makeImage({ id: "pano1", is_pano: true }),
          makeImage({ id: "flat1", is_pano: false }),
          makeImage({ id: "flat2", is_pano: false }),
        ],
      }),
    );

    const results = await mapillaryPhotoProvider.search({ lat: 48.85, lng: 2.35, limit: 10 });

    expect(
      results.every((r) => r.url !== "https://scontent.mapillary.com/pano1/thumb-1024.jpg"),
    ).toBe(true);
    expect(results).toHaveLength(2);
  });

  it("sorts by distance to query point (closest first)", async () => {
    const { mapillaryPhotoProvider } = await loadModule();
    // far image first in API response, close image second
    mockFetch.mockResolvedValue(
      mockOk({
        data: [
          makeImage({
            id: "far",
            geometry: { type: "Point", coordinates: [2.36, 48.86] },
            is_pano: false,
          }),
          makeImage({
            id: "close",
            geometry: { type: "Point", coordinates: [2.3501, 48.8501] },
            is_pano: false,
          }),
        ],
      }),
    );

    const results = await mapillaryPhotoProvider.search({ lat: 48.85, lng: 2.35, limit: 10 });

    expect(results).toHaveLength(2);
    // Closest should be first
    expect(results[0].pageUrl).toContain("close");
    expect(results[1].pageUrl).toContain("far");
  });

  it("returns up to limit images", async () => {
    const { mapillaryPhotoProvider } = await loadModule();
    const images = Array.from({ length: 10 }, (_, i) =>
      makeImage({ id: `img${i}`, is_pano: false }),
    );
    mockFetch.mockResolvedValue(mockOk({ data: images }));

    const results = await mapillaryPhotoProvider.search({ lat: 48.85, lng: 2.35, limit: 3 });

    expect(results).toHaveLength(3);
  });

  it("uses thumb_1024_url when available", async () => {
    const { mapillaryPhotoProvider } = await loadModule();
    mockFetch.mockResolvedValue(
      mockOk({
        data: [makeImage({ thumb_1024_url: "https://example.com/1024.jpg" })],
      }),
    );

    const results = await mapillaryPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results[0].url).toBe("https://example.com/1024.jpg");
  });

  it("falls back to scontent URL when thumb_1024_url is missing", async () => {
    const { mapillaryPhotoProvider } = await loadModule();
    mockFetch.mockResolvedValue(
      mockOk({
        data: [makeImage({ id: "abc123", thumb_1024_url: undefined })],
      }),
    );

    const results = await mapillaryPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results[0].url).toBe("https://scontent.mapillary.com/abc123/thumb-1024.jpg");
  });

  it("formats attribution as '{username} / Mapillary (CC BY-SA 4.0)'", async () => {
    const { mapillaryPhotoProvider } = await loadModule();
    mockFetch.mockResolvedValue(
      mockOk({
        data: [makeImage({ creator: { username: "alice" } })],
      }),
    );

    const results = await mapillaryPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results[0].attribution).toBe("alice / Mapillary (CC BY-SA 4.0)");
    expect(results[0].author).toBe("alice");
  });

  it("uses 'Mapillary (CC BY-SA 4.0)' attribution when no username", async () => {
    const { mapillaryPhotoProvider } = await loadModule();
    mockFetch.mockResolvedValue(
      mockOk({
        data: [makeImage({ creator: undefined })],
      }),
    );

    const results = await mapillaryPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results[0].attribution).toBe("Mapillary (CC BY-SA 4.0)");
    expect(results[0].author).toBeUndefined();
  });

  it("converts captured_at (milliseconds) to ISO 8601", async () => {
    const { mapillaryPhotoProvider } = await loadModule();
    const timestamp = 1700000000000; // 2023-11-14T22:13:20.000Z
    mockFetch.mockResolvedValue(
      mockOk({
        data: [makeImage({ captured_at: timestamp })],
      }),
    );

    const results = await mapillaryPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results[0].capturedAt).toBe(new Date(timestamp).toISOString());
  });

  it("returns [] when MAPILLARY_TOKEN is missing", async () => {
    vi.stubEnv("MAPILLARY_TOKEN", "");
    // Re-import to pick up env change — but the provider reads env at call time
    const { mapillaryPhotoProvider } = await loadModule();

    // Override process.env directly since the provider checks at runtime
    delete process.env.MAPILLARY_TOKEN;

    const results = await mapillaryPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns [] on HTTP error", async () => {
    const { mapillaryPhotoProvider } = await loadModule();
    mockFetch.mockResolvedValue(mockNotOk(500));

    const results = await mapillaryPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results).toEqual([]);
  });

  it("returns [] on network error (fetch throws)", async () => {
    const { mapillaryPhotoProvider } = await loadModule();
    mockFetch.mockRejectedValue(new Error("Network error"));

    const results = await mapillaryPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results).toEqual([]);
  });

  it("sets coordinates from image geometry", async () => {
    const { mapillaryPhotoProvider } = await loadModule();
    mockFetch.mockResolvedValue(
      mockOk({
        data: [makeImage({ geometry: { type: "Point", coordinates: [13.4, 52.52] } })],
      }),
    );

    const results = await mapillaryPhotoProvider.search({ lat: 52.52, lng: 13.4 });

    expect(results[0].coordinates).toEqual([13.4, 52.52]);
  });

  it("sets license and licenseUrl correctly", async () => {
    const { mapillaryPhotoProvider } = await loadModule();
    mockFetch.mockResolvedValue(mockOk({ data: [makeImage()] }));

    const results = await mapillaryPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results[0].license).toBe("CC BY-SA 4.0");
    expect(results[0].licenseUrl).toBe("https://creativecommons.org/licenses/by-sa/4.0");
  });

  it("builds correct pageUrl with image id", async () => {
    const { mapillaryPhotoProvider } = await loadModule();
    mockFetch.mockResolvedValue(mockOk({ data: [makeImage({ id: "999888" })] }));

    const results = await mapillaryPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results[0].pageUrl).toBe("https://www.mapillary.com/app/?pKey=999888");
  });
});
