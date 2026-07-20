import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wikimediaProvider } from "./provider.js";

// The Wikimedia provider resolves the OSM `wikimedia_commons` tag (File:/
// Category:) and runs a coordinate geosearch, both against the Commons
// `w/api.php`. These tests pin the rich-metadata parse (author/license/page
// URL from extmetadata), the File:-tag direct path, the geosearch size/extension
// filters, and the requested generators. The mock routes by URL so a single
// `search()` call (tags then geo) can be driven from one responder.

function commonsPage(overrides: Record<string, unknown> = {}) {
  return {
    title: "File:Eiffel Tower.jpg",
    imageinfo: [
      {
        url: "https://upload.wikimedia.org/wikipedia/commons/a/a8/Eiffel_Tower.jpg",
        thumburl: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a8/Eiffel.jpg/800px.jpg",
        size: 2_000_000,
        width: 4000,
        height: 3000,
        extmetadata: {
          Artist: { value: '<a href="/wiki/User:Jane">Jane Doe</a>' },
          LicenseShortName: { value: "CC BY-SA 4.0" },
          LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" },
          DateTimeOriginal: { value: "2022-07-01 12:00:00" },
        },
      },
    ],
    coordinates: [{ lat: 48.8584, lon: 2.2945 }],
    ...overrides,
  };
}

function mockOkText(data: unknown) {
  return JSON.stringify(data);
}

let mockFetch: ReturnType<typeof vi.fn>;
// url-substring → JSON body for that endpoint.
let routes: Record<string, unknown>;

beforeEach(() => {
  routes = {};
  mockFetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    for (const [pattern, body] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return {
          ok: true,
          status: 200,
          json: async () => body,
          text: async () => mockOkText(body),
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Wikimedia photo provider — File: tag", () => {
  it("returns the rich PlacePhoto parsed from Commons extmetadata", async () => {
    // `titles=` is unique to the fetchCommonsMetadata call.
    routes = {
      "titles=": { query: { pages: { "1": commonsPage() } } },
      "generator=geosearch": { query: { pages: {} } },
    };

    const photos = await wikimediaProvider.search({
      lat: 48.8584,
      lng: 2.2945,
      osmTags: { wikimedia_commons: "File:Eiffel Tower.jpg" },
    });

    expect(photos[0]).toMatchObject({
      url: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a8/Eiffel.jpg/800px.jpg",
      source: "wikimedia",
      author: "Jane Doe",
      authorUrl: "https://commons.wikimedia.org/wiki/User:Jane",
      license: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
      coordinates: [2.2945, 48.8584],
    });
    expect(photos[0]?.pageUrl).toContain("commons.wikimedia.org/wiki/File:Eiffel_Tower.jpg");
  });

  it("falls back to a Special:FilePath URL when Commons returns no metadata", async () => {
    routes = {
      "titles=": { query: { pages: {} } },
      "generator=geosearch": { query: { pages: {} } },
    };

    const photos = await wikimediaProvider.search({
      lat: 0,
      lng: 0,
      osmTags: { wikimedia_commons: "File:Missing.jpg" },
    });

    expect(photos[0]).toEqual({
      url: "https://commons.wikimedia.org/wiki/Special:FilePath/Missing.jpg?width=800",
      source: "wikimedia",
      // Metadata fetch failed, so author/license are unknown, but the filename
      // is known — link to the Commons file page instead.
      pageUrl: "https://commons.wikimedia.org/wiki/File:Missing.jpg",
    });
  });
});

describe("Wikimedia photo provider — Category tag", () => {
  it("requests categorymembers and parses each returned page", async () => {
    routes = {
      "generator=categorymembers": { query: { pages: { "10": commonsPage() } } },
      "generator=geosearch": { query: { pages: {} } },
    };

    const photos = await wikimediaProvider.searchByTags({ wikimedia_commons: "Category:Paris" });

    expect(photos).toHaveLength(1);
    expect(photos[0]?.author).toBe("Jane Doe");
    const catUrl = mockFetch.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes("generator=categorymembers"));
    expect(catUrl).toContain("gcmtitle=Category%3AParis");
  });
});

describe("Wikimedia photo provider — geosearch", () => {
  it("filters out oversized originals and rejected extensions", async () => {
    routes = {
      "generator=geosearch": {
        query: {
          pages: {
            // kept — normal JPEG.
            "1": commonsPage(),
            // rejected — SVG.
            "2": commonsPage({ title: "File:Map.svg" }),
            // rejected — exceeds the 50 MB size cap.
            "3": commonsPage({
              title: "File:Huge.jpg",
              imageinfo: [{ ...commonsPage().imageinfo[0], size: 60 * 1024 * 1024 }],
            }),
            // rejected — exceeds the 8000 px dimension cap.
            "4": commonsPage({
              title: "File:Wide.jpg",
              imageinfo: [{ ...commonsPage().imageinfo[0], width: 9000 }],
            }),
          },
        },
      },
    };

    const photos = await wikimediaProvider.search({ lat: 48.8584, lng: 2.2945 });

    expect(photos).toHaveLength(1);
    expect(photos[0]?.license).toBe("CC BY-SA 4.0");
    const geoUrl = String(mockFetch.mock.calls[0]?.[0]);
    expect(geoUrl).toContain("ggscoord=48.8584%7C2.2945");
    expect(geoUrl).toContain("ggsradius=500");
  });

  it("returns an empty array when the geosearch call fails", async () => {
    routes = {}; // every fetch resolves to 404.

    expect(await wikimediaProvider.search({ lat: 48.8584, lng: 2.2945 })).toEqual([]);
  });
});
