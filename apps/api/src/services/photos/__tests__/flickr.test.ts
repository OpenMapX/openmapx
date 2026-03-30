import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  vi.stubEnv("FLICKR_API_KEY", "test-api-key");
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

function makeFlickrPhoto(overrides: Record<string, unknown> = {}) {
  return {
    id: "12345",
    owner: "owner123",
    secret: "abc123",
    server: "65535",
    title: "Test Photo",
    license: "4",
    ownername: "testuser",
    datetaken: "2023-04-15 14:30:00",
    url_l: "https://live.staticflickr.com/65535/12345_abc123_b.jpg",
    url_z: "https://live.staticflickr.com/65535/12345_abc123_z.jpg",
    url_m: "https://live.staticflickr.com/65535/12345_abc123_m.jpg",
    url_sq: "https://live.staticflickr.com/65535/12345_abc123_sq.jpg",
    ...overrides,
  };
}

async function loadModule() {
  return import("@integrations/photos-flickr/provider.js");
}

describe("flickrPhotoProvider", () => {
  describe("URL priority", () => {
    it("uses url_l when available", async () => {
      const { flickrPhotoProvider } = await loadModule();
      mockFetch.mockResolvedValue(mockOk({ photos: { photo: [makeFlickrPhoto()] } }));

      const results = await flickrPhotoProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results[0].url).toBe("https://live.staticflickr.com/65535/12345_abc123_b.jpg");
    });

    it("falls back to url_z when url_l is missing", async () => {
      const { flickrPhotoProvider } = await loadModule();
      mockFetch.mockResolvedValue(
        mockOk({
          photos: {
            photo: [makeFlickrPhoto({ url_l: undefined })],
          },
        }),
      );

      const results = await flickrPhotoProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results[0].url).toBe("https://live.staticflickr.com/65535/12345_abc123_z.jpg");
    });

    it("falls back to url_m when url_l and url_z are missing", async () => {
      const { flickrPhotoProvider } = await loadModule();
      mockFetch.mockResolvedValue(
        mockOk({
          photos: {
            photo: [makeFlickrPhoto({ url_l: undefined, url_z: undefined })],
          },
        }),
      );

      const results = await flickrPhotoProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results[0].url).toBe("https://live.staticflickr.com/65535/12345_abc123_m.jpg");
    });

    it("falls back to buildFlickrUrl(photo, 'b') when all url_* are missing", async () => {
      const { flickrPhotoProvider } = await loadModule();
      mockFetch.mockResolvedValue(
        mockOk({
          photos: {
            photo: [
              makeFlickrPhoto({
                url_l: undefined,
                url_z: undefined,
                url_m: undefined,
              }),
            ],
          },
        }),
      );

      const results = await flickrPhotoProvider.search({ lat: 48.85, lng: 2.35 });

      // buildFlickrUrl: https://live.staticflickr.com/{server}/{id}_{secret}_{size}.jpg
      expect(results[0].url).toBe("https://live.staticflickr.com/65535/12345_abc123_b.jpg");
    });
  });

  describe("thumbnail URL", () => {
    it("uses url_sq when available", async () => {
      const { flickrPhotoProvider } = await loadModule();
      mockFetch.mockResolvedValue(mockOk({ photos: { photo: [makeFlickrPhoto()] } }));

      const results = await flickrPhotoProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results[0].thumbnailUrl).toBe(
        "https://live.staticflickr.com/65535/12345_abc123_sq.jpg",
      );
    });

    it("falls back to buildFlickrUrl(photo, 'q') when url_sq is missing", async () => {
      const { flickrPhotoProvider } = await loadModule();
      mockFetch.mockResolvedValue(
        mockOk({
          photos: {
            photo: [makeFlickrPhoto({ url_sq: undefined })],
          },
        }),
      );

      const results = await flickrPhotoProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results[0].thumbnailUrl).toBe(
        "https://live.staticflickr.com/65535/12345_abc123_q.jpg",
      );
    });
  });

  describe("license mapping", () => {
    it("maps license '4' to 'CC BY 2.0'", async () => {
      const { flickrPhotoProvider } = await loadModule();
      mockFetch.mockResolvedValue(
        mockOk({ photos: { photo: [makeFlickrPhoto({ license: "4" })] } }),
      );

      const results = await flickrPhotoProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results[0].license).toBe("CC BY 2.0");
    });

    it("maps license '5' to 'CC BY-SA 2.0'", async () => {
      const { flickrPhotoProvider } = await loadModule();
      mockFetch.mockResolvedValue(
        mockOk({ photos: { photo: [makeFlickrPhoto({ license: "5" })] } }),
      );

      const results = await flickrPhotoProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results[0].license).toBe("CC BY-SA 2.0");
    });

    it("maps license '9' to 'CC0 1.0'", async () => {
      const { flickrPhotoProvider } = await loadModule();
      mockFetch.mockResolvedValue(
        mockOk({ photos: { photo: [makeFlickrPhoto({ license: "9" })] } }),
      );

      const results = await flickrPhotoProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results[0].license).toBe("CC0 1.0");
    });

    it("maps license '10' to 'Public Domain'", async () => {
      const { flickrPhotoProvider } = await loadModule();
      mockFetch.mockResolvedValue(
        mockOk({ photos: { photo: [makeFlickrPhoto({ license: "10" })] } }),
      );

      const results = await flickrPhotoProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results[0].license).toBe("Public Domain");
    });

    it("uses fallback 'License X' for unknown license ids", async () => {
      const { flickrPhotoProvider } = await loadModule();
      mockFetch.mockResolvedValue(
        mockOk({ photos: { photo: [makeFlickrPhoto({ license: "99" })] } }),
      );

      const results = await flickrPhotoProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results[0].license).toBe("License 99");
    });
  });

  describe("capturedAt", () => {
    it("parses 'YYYY-MM-DD HH:mm:ss' format to ISO 8601", async () => {
      const { flickrPhotoProvider } = await loadModule();
      mockFetch.mockResolvedValue(
        mockOk({
          photos: { photo: [makeFlickrPhoto({ datetaken: "2023-04-15 14:30:00" })] },
        }),
      );

      const results = await flickrPhotoProvider.search({ lat: 48.85, lng: 2.35 });

      // The source replaces space with "T" then calls new Date().toISOString()
      expect(results[0].capturedAt).toBe(new Date("2023-04-15T14:30:00").toISOString());
    });

    it("returns undefined when datetaken is missing", async () => {
      const { flickrPhotoProvider } = await loadModule();
      mockFetch.mockResolvedValue(
        mockOk({
          photos: { photo: [makeFlickrPhoto({ datetaken: undefined })] },
        }),
      );

      const results = await flickrPhotoProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results[0].capturedAt).toBeUndefined();
    });
  });

  it("returns [] when FLICKR_API_KEY is missing", async () => {
    delete process.env.FLICKR_API_KEY;
    const { flickrPhotoProvider } = await loadModule();

    const results = await flickrPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns [] on HTTP error", async () => {
    const { flickrPhotoProvider } = await loadModule();
    mockFetch.mockResolvedValue(mockNotOk(500));

    const results = await flickrPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results).toEqual([]);
  });

  it("returns [] on network error (fetch throws)", async () => {
    const { flickrPhotoProvider } = await loadModule();
    mockFetch.mockRejectedValue(new Error("Network error"));

    const results = await flickrPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results).toEqual([]);
  });

  it("returns [] when photos.photo is empty", async () => {
    const { flickrPhotoProvider } = await loadModule();
    mockFetch.mockResolvedValue(mockOk({ photos: { photo: [] } }));

    const results = await flickrPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results).toEqual([]);
  });

  it("returns [] when photos object is missing", async () => {
    const { flickrPhotoProvider } = await loadModule();
    mockFetch.mockResolvedValue(mockOk({}));

    const results = await flickrPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results).toEqual([]);
  });

  it("builds correct attribution string", async () => {
    const { flickrPhotoProvider } = await loadModule();
    mockFetch.mockResolvedValue(
      mockOk({
        photos: {
          photo: [makeFlickrPhoto({ ownername: "Alice", license: "5" })],
        },
      }),
    );

    const results = await flickrPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results[0].attribution).toBe("Alice / Flickr (CC BY-SA 2.0)");
  });

  it("uses owner as author fallback when ownername is missing", async () => {
    const { flickrPhotoProvider } = await loadModule();
    mockFetch.mockResolvedValue(
      mockOk({
        photos: {
          photo: [makeFlickrPhoto({ ownername: undefined, owner: "owner456" })],
        },
      }),
    );

    const results = await flickrPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results[0].author).toBe("owner456");
  });

  it("builds correct pageUrl and authorUrl", async () => {
    const { flickrPhotoProvider } = await loadModule();
    mockFetch.mockResolvedValue(
      mockOk({
        photos: {
          photo: [makeFlickrPhoto({ id: "999", owner: "user42" })],
        },
      }),
    );

    const results = await flickrPhotoProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results[0].pageUrl).toBe("https://www.flickr.com/photos/user42/999");
    expect(results[0].authorUrl).toBe("https://www.flickr.com/photos/user42");
  });
});
