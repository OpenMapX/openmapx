import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flickrPhotoProvider, setFlickrApiKey } from "./provider.js";

// Flickr's photos.search returns size-variant URLs (url_l/url_z/url_m/url_sq)
// plus a numeric license id. These tests pin the size-preference fallback, the
// license id → name/URL mapping, the attribution/author assembly, the
// `datetaken` → ISO conversion, and the no-key / empty-result short-circuits.

function mockOk(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as Response;
}

const QUERY = { lat: 48.8584, lng: 2.2945, limit: 6 };

function flickrPhoto(overrides: Record<string, unknown> = {}) {
  return {
    id: "53000000001",
    owner: "12345@N00",
    secret: "abc123",
    server: "65535",
    title: "Eiffel Tower at dusk",
    license: "4",
    ownername: "Jane Photographer",
    datetaken: "2023-04-15 14:30:00",
    url_sq: "https://live.staticflickr.com/65535/53000000001_abc123_q.jpg",
    url_m: "https://live.staticflickr.com/65535/53000000001_abc123_m.jpg",
    url_z: "https://live.staticflickr.com/65535/53000000001_abc123_z.jpg",
    url_l: "https://live.staticflickr.com/65535/53000000001_abc123_b.jpg",
    ...overrides,
  };
}

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  setFlickrApiKey("test-flickr-key");
});

afterEach(() => {
  setFlickrApiKey(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Flickr photo provider", () => {
  it("maps a CC BY photo to the full PlacePhoto shape", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ photos: { photo: [flickrPhoto()] } }));

    const photos = await flickrPhotoProvider.search(QUERY);

    expect(photos).toEqual([
      {
        url: "https://live.staticflickr.com/65535/53000000001_abc123_b.jpg",
        thumbnailUrl: "https://live.staticflickr.com/65535/53000000001_abc123_q.jpg",
        source: "flickr",
        author: "Jane Photographer",
        authorUrl: "https://www.flickr.com/photos/12345@N00",
        license: "CC BY 2.0",
        licenseUrl: "https://creativecommons.org/licenses/by/2.0",
        pageUrl: "https://www.flickr.com/photos/12345@N00/53000000001",
        capturedAt: new Date("2023-04-15T14:30:00").toISOString(),
      },
    ]);
  });

  it("requests commercial-use licenses and the search params", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ photos: { photo: [] } }));

    await flickrPhotoProvider.search(QUERY);

    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain("method=flickr.photos.search");
    expect(url).toContain("api_key=test-flickr-key");
    expect(url).toContain("license=4%2C5%2C6%2C7%2C8%2C9%2C10");
    expect(url).toContain("lat=48.8584");
    expect(url).toContain("lon=2.2945");
  });

  it("falls back through the size variants when the largest is absent", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        photos: {
          photo: [flickrPhoto({ url_l: undefined, url_z: undefined, url_sq: undefined })],
        },
      }),
    );

    const [photo] = await flickrPhotoProvider.search(QUERY);

    // url_m is the next available size; url_sq missing → constructed `_q` thumb.
    expect(photo.url).toBe("https://live.staticflickr.com/65535/53000000001_abc123_m.jpg");
    expect(photo.thumbnailUrl).toBe("https://live.staticflickr.com/65535/53000000001_abc123_q.jpg");
  });

  it("constructs the static URL from server/id/secret when no extras URLs exist", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        photos: {
          photo: [
            flickrPhoto({
              url_l: undefined,
              url_z: undefined,
              url_m: undefined,
              url_sq: undefined,
            }),
          ],
        },
      }),
    );

    const [photo] = await flickrPhotoProvider.search(QUERY);

    expect(photo.url).toBe("https://live.staticflickr.com/65535/53000000001_abc123_b.jpg");
    expect(photo.thumbnailUrl).toBe("https://live.staticflickr.com/65535/53000000001_abc123_q.jpg");
  });

  it("labels an unknown license id and omits the license URL", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({ photos: { photo: [flickrPhoto({ license: "99" })] } }),
    );

    const [photo] = await flickrPhotoProvider.search(QUERY);

    expect(photo.license).toBe("License 99");
    expect(photo.licenseUrl).toBeUndefined();
  });

  it("falls back to the owner nsid when no display name is present", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        photos: { photo: [flickrPhoto({ ownername: undefined, datetaken: undefined })] },
      }),
    );

    const [photo] = await flickrPhotoProvider.search(QUERY);

    expect(photo.author).toBe("12345@N00");
    expect(photo.capturedAt).toBeUndefined();
  });

  it("returns an empty array when no API key is configured", async () => {
    setFlickrApiKey(undefined);

    expect(await flickrPhotoProvider.search(QUERY)).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns an empty array when the upstream call fails", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    expect(await flickrPhotoProvider.search(QUERY)).toEqual([]);
  });
});
