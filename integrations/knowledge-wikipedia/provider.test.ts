import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wikipediaSource } from "./provider.js";

// The Wikipedia knowledge provider resolves the OSM `wikipedia` tag
// ("en:Title" or "Title") against the REST summary endpoint, then enriches the
// lead image with Commons metadata. These tests pin the lang/title split, the
// summary → KnowledgeResult mapping, the upload-URL → Commons-filename
// extraction, and the metadata-failure fallback.

function summaryBody(overrides: Record<string, unknown> = {}) {
  return {
    description: "Iron lattice tower in Paris",
    extract: "The Eiffel Tower is a wrought-iron lattice tower on the Champ de Mars in Paris.",
    thumbnail: {
      source:
        "https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/Tour_Eiffel.jpg/320px-Tour_Eiffel.jpg",
      width: 320,
      height: 480,
    },
    originalimage: {
      source: "https://upload.wikimedia.org/wikipedia/commons/8/85/Tour_Eiffel.jpg",
      width: 2000,
      height: 3000,
    },
    content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Eiffel_Tower" } },
    ...overrides,
  };
}

let mockFetch: ReturnType<typeof vi.fn>;
let routes: Record<string, unknown>;

beforeEach(() => {
  routes = {};
  mockFetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    for (const [pattern, body] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return { ok: true, status: 200, json: async () => body };
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

describe("Wikipedia knowledge provider", () => {
  it("returns null when the wikipedia tag is absent", async () => {
    expect(await wikipediaSource.lookup({})).toBeNull();
  });

  it("splits an 'en:Title' tag and maps the summary into a KnowledgeResult", async () => {
    routes = {
      "/page/summary/": summaryBody(),
      // Commons metadata lookup for the lead image — return none so we exercise
      // the summary mapping without the rich-photo branch.
      "titles=": { query: { pages: {} } },
    };

    const result = await wikipediaSource.lookup({ wikipedia: "en:Eiffel Tower" });

    expect(result).toMatchObject({
      description: "Iron lattice tower in Paris",
      wikipediaExtract: summaryBody().extract,
      wikipediaExtractSource: "knowledge-wikipedia",
      wikipediaUrl: "https://en.wikipedia.org/wiki/Eiffel_Tower",
    });
    const summaryUrl = mockFetch.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes("/page/summary/"));
    expect(summaryUrl).toBe("https://en.wikipedia.org/api/rest_v1/page/summary/Eiffel_Tower");
  });

  it("derives the language from the tag prefix, not the lang arg", async () => {
    routes = { "/page/summary/": summaryBody(), "titles=": { query: { pages: {} } } };

    await wikipediaSource.lookup({ wikipedia: "de:Eiffelturm" }, "en");

    const summaryUrl = mockFetch.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes("/page/summary/"));
    expect(summaryUrl).toBe("https://de.wikipedia.org/api/rest_v1/page/summary/Eiffelturm");
  });

  it("extracts the Commons filename and attaches the rich photo", async () => {
    routes = {
      "/page/summary/": summaryBody(),
      "titles=": {
        query: {
          pages: {
            "1": {
              title: "File:Tour Eiffel.jpg",
              imageinfo: [
                {
                  url: "https://upload.wikimedia.org/wikipedia/commons/8/85/Tour_Eiffel.jpg",
                  thumburl: "https://upload.wikimedia.org/thumb/8/85/Tour_Eiffel.jpg/800px.jpg",
                  extmetadata: {
                    Artist: { value: "Benh LIEU SONG" },
                    LicenseShortName: { value: "CC BY-SA 3.0" },
                  },
                },
              ],
            },
          },
        },
      },
    };

    const result = await wikipediaSource.lookup({ wikipedia: "en:Eiffel Tower" });

    expect(result?.photos).toHaveLength(1);
    // Provider overrides the source to "wikipedia" for rich photos it attaches.
    expect(result?.photos?.[0]).toMatchObject({
      source: "wikipedia",
      author: "Benh LIEU SONG",
      license: "CC BY-SA 3.0",
    });
    const titlesUrl = mockFetch.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes("titles="));
    expect(titlesUrl).toContain("titles=File%3ATour_Eiffel.jpg");
  });

  it("falls back to the raw image URLs when Commons metadata is unavailable", async () => {
    routes = { "/page/summary/": summaryBody(), "titles=": { query: { pages: {} } } };

    const result = await wikipediaSource.lookup({ wikipedia: "en:Eiffel Tower" });

    expect(result?.photos?.[0]).toEqual({
      url: "https://upload.wikimedia.org/wikipedia/commons/8/85/Tour_Eiffel.jpg",
      thumbnailUrl:
        "https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/Tour_Eiffel.jpg/320px-Tour_Eiffel.jpg",
      source: "wikipedia",
      // Filename WAS extractable, so the file page is known even though the
      // metadata fetch itself returned nothing.
      pageUrl: "https://commons.wikimedia.org/wiki/File:Tour_Eiffel.jpg",
    });
  });

  it("returns null when the summary request fails", async () => {
    routes = {}; // summary fetch resolves to 404.

    expect(await wikipediaSource.lookup({ wikipedia: "en:Nonexistent" })).toBeNull();
  });
});
