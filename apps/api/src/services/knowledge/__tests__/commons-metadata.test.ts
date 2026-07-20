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

function mockNotOk() {
  return { ok: false, status: 500 } as Response;
}

async function loadModule() {
  return import("../commons-metadata.js");
}

// parseCommonsPage

describe("parseCommonsPage", () => {
  it("returns undefined when page has no imageinfo", async () => {
    const { parseCommonsPage } = await loadModule();
    const result = parseCommonsPage({ title: "File:Test.jpg" });
    expect(result).toBeUndefined();
  });

  it("returns undefined when imageinfo has no url or thumburl", async () => {
    const { parseCommonsPage } = await loadModule();
    const result = parseCommonsPage({
      title: "File:Test.jpg",
      imageinfo: [{ size: 12345 }],
    });
    expect(result).toBeUndefined();
  });

  it("prefers thumburl over url", async () => {
    const { parseCommonsPage } = await loadModule();
    const result = parseCommonsPage({
      title: "File:Test.jpg",
      imageinfo: [
        {
          url: "https://upload.wikimedia.org/original/Test.jpg",
          thumburl: "https://upload.wikimedia.org/thumb/Test.jpg/800px-Test.jpg",
        },
      ],
    });
    expect(result?.url).toBe("https://upload.wikimedia.org/thumb/Test.jpg/800px-Test.jpg");
  });

  it("uses url when thumburl is missing", async () => {
    const { parseCommonsPage } = await loadModule();
    const result = parseCommonsPage({
      title: "File:Test.jpg",
      imageinfo: [{ url: "https://upload.wikimedia.org/original/Test.jpg" }],
    });
    expect(result?.url).toBe("https://upload.wikimedia.org/original/Test.jpg");
  });

  it('strips "File:" prefix from title', async () => {
    const { parseCommonsPage } = await loadModule();
    const result = parseCommonsPage({
      title: "File:Berlin Skyline.jpg",
      imageinfo: [{ thumburl: "https://example.com/thumb.jpg" }],
    });
    expect(result?.pageUrl).toContain("Berlin_Skyline.jpg");
    expect(result?.pageUrl).not.toContain("File%3A");
  });

  it("strips HTML from Artist value", async () => {
    const { parseCommonsPage } = await loadModule();
    const result = parseCommonsPage({
      title: "File:Test.jpg",
      imageinfo: [
        {
          thumburl: "https://example.com/thumb.jpg",
          extmetadata: {
            Artist: { value: '<a href="/wiki/User:John">John</a>' },
          },
        },
      ],
    });
    expect(result?.author).toBe("John");
  });

  it("extracts href from HTML — relative /wiki/ → prepends commons base URL", async () => {
    const { parseCommonsPage } = await loadModule();
    const result = parseCommonsPage({
      title: "File:Test.jpg",
      imageinfo: [
        {
          thumburl: "https://example.com/thumb.jpg",
          extmetadata: {
            Artist: { value: '<a href="/wiki/User:John">John</a>' },
          },
        },
      ],
    });
    expect(result?.authorUrl).toBe("https://commons.wikimedia.org/wiki/User:John");
  });

  it("extracts absolute href without modification", async () => {
    const { parseCommonsPage } = await loadModule();
    const result = parseCommonsPage({
      title: "File:Test.jpg",
      imageinfo: [
        {
          thumburl: "https://example.com/thumb.jpg",
          extmetadata: {
            Artist: { value: '<a href="https://example.com/author">Author</a>' },
          },
        },
      ],
    });
    expect(result?.authorUrl).toBe("https://example.com/author");
  });

  it("extracts author from Artist extmetadata", async () => {
    const { parseCommonsPage } = await loadModule();
    const result = parseCommonsPage({
      title: "File:Test.jpg",
      imageinfo: [
        {
          thumburl: "https://example.com/thumb.jpg",
          extmetadata: {
            Artist: { value: "John" },
            LicenseShortName: { value: "CC BY-SA" },
          },
        },
      ],
    });
    expect(result?.author).toBe("John");
    expect(result?.license).toBe("CC BY-SA");
  });

  it("author is undefined when Artist extmetadata is absent", async () => {
    const { parseCommonsPage } = await loadModule();
    const result = parseCommonsPage({
      title: "File:Test.jpg",
      imageinfo: [
        {
          thumburl: "https://example.com/thumb.jpg",
          extmetadata: {
            LicenseShortName: { value: "CC BY-SA 4.0" },
          },
        },
      ],
    });
    expect(result?.author).toBeUndefined();
    expect(result?.license).toBe("CC BY-SA 4.0");
  });

  it("license is undefined when LicenseShortName is missing — never assume a licence", async () => {
    const { parseCommonsPage } = await loadModule();
    const result = parseCommonsPage({
      title: "File:Test.jpg",
      imageinfo: [{ thumburl: "https://example.com/thumb.jpg" }],
    });
    expect(result?.license).toBeUndefined();
  });

  it('DateTimeOriginal "2020-05-15 12:30:00" → ISO 8601', async () => {
    const { parseCommonsPage } = await loadModule();
    const result = parseCommonsPage({
      title: "File:Test.jpg",
      imageinfo: [
        {
          thumburl: "https://example.com/thumb.jpg",
          extmetadata: {
            DateTimeOriginal: { value: "2020-05-15 12:30:00" },
          },
        },
      ],
    });
    expect(result?.capturedAt).toBe(new Date("2020-05-15T12:30:00").toISOString());
  });

  it('"Taken on 15 May 2020" → cleaned and parsed', async () => {
    const { parseCommonsPage } = await loadModule();
    const result = parseCommonsPage({
      title: "File:Test.jpg",
      imageinfo: [
        {
          thumburl: "https://example.com/thumb.jpg",
          extmetadata: {
            DateTimeOriginal: { value: "Taken on 15 May 2020" },
          },
        },
      ],
    });
    expect(result?.capturedAt).toBeDefined();
    const parsed = new Date(result?.capturedAt ?? "");
    expect(parsed.getFullYear()).toBe(2020);
    expect(parsed.getMonth()).toBe(4); // May = 4 (zero-indexed)
    expect(parsed.getDate()).toBe(15);
  });

  it("invalid date → undefined capturedAt", async () => {
    const { parseCommonsPage } = await loadModule();
    const result = parseCommonsPage({
      title: "File:Test.jpg",
      imageinfo: [
        {
          thumburl: "https://example.com/thumb.jpg",
          extmetadata: {
            DateTimeOriginal: { value: "not a date at all" },
          },
        },
      ],
    });
    expect(result?.capturedAt).toBeUndefined();
  });

  it("coordinates from page.coordinates[0] as [lon, lat]", async () => {
    const { parseCommonsPage } = await loadModule();
    const result = parseCommonsPage({
      title: "File:Test.jpg",
      imageinfo: [{ thumburl: "https://example.com/thumb.jpg" }],
      coordinates: [{ lat: 52.52, lon: 13.405 }],
    });
    expect(result?.coordinates).toEqual([13.405, 52.52]);
  });

  it("no coordinates → undefined", async () => {
    const { parseCommonsPage } = await loadModule();
    const result = parseCommonsPage({
      title: "File:Test.jpg",
      imageinfo: [{ thumburl: "https://example.com/thumb.jpg" }],
    });
    expect(result?.coordinates).toBeUndefined();
  });

  it("pageUrl from encoded filename (spaces → underscores)", async () => {
    const { parseCommonsPage } = await loadModule();
    const result = parseCommonsPage({
      title: "File:Berlin City Hall.jpg",
      imageinfo: [{ thumburl: "https://example.com/thumb.jpg" }],
    });
    expect(result?.pageUrl).toBe("https://commons.wikimedia.org/wiki/File:Berlin_City_Hall.jpg");
  });

  it("stores licenseUrl from extmetadata", async () => {
    const { parseCommonsPage } = await loadModule();
    const result = parseCommonsPage({
      title: "File:Test.jpg",
      imageinfo: [
        {
          thumburl: "https://example.com/thumb.jpg",
          extmetadata: {
            LicenseShortName: { value: "CC BY 4.0" },
            LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" },
          },
        },
      ],
    });
    expect(result?.licenseUrl).toBe("https://creativecommons.org/licenses/by/4.0/");
  });

  it("sets source to 'wikimedia'", async () => {
    const { parseCommonsPage } = await loadModule();
    const result = parseCommonsPage({
      title: "File:Test.jpg",
      imageinfo: [{ thumburl: "https://example.com/thumb.jpg" }],
    });
    expect(result?.source).toBe("wikimedia");
  });
});

// fetchCommonsMetadata

describe("fetchCommonsMetadata", () => {
  it("returns empty Map for empty filenames array", async () => {
    const { fetchCommonsMetadata } = await loadModule();
    const result = await fetchCommonsMetadata([]);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('filenames joined with "|" in API titles param', async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ query: { pages: {} } }));

    const { fetchCommonsMetadata } = await loadModule();
    await fetchCommonsMetadata(["Berlin.jpg", "Paris.jpg"]);

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("titles=File%3ABerlin.jpg%7CFile%3AParis.jpg");
  });

  it("returns Map with filename keys (underscores → spaces)", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        query: {
          pages: {
            "1": {
              title: "File:Berlin_Skyline.jpg",
              imageinfo: [
                {
                  thumburl: "https://example.com/thumb.jpg",
                  extmetadata: {
                    Artist: { value: "John" },
                  },
                },
              ],
            },
          },
        },
      }),
    );

    const { fetchCommonsMetadata } = await loadModule();
    const result = await fetchCommonsMetadata(["Berlin_Skyline.jpg"]);

    expect(result.has("Berlin Skyline.jpg")).toBe(true);
    const photo = result.get("Berlin Skyline.jpg");
    expect(photo?.url).toBe("https://example.com/thumb.jpg");
    expect(photo?.author).toBe("John");
  });

  it("returns empty Map on API timeout", async () => {
    mockFetch.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));

    const { fetchCommonsMetadata } = await loadModule();
    const result = await fetchCommonsMetadata(["Test.jpg"]);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it("returns empty Map on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce(mockNotOk());

    const { fetchCommonsMetadata } = await loadModule();
    const result = await fetchCommonsMetadata(["Test.jpg"]);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it("pages without valid imageinfo are skipped", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk({
        query: {
          pages: {
            "1": {
              title: "File:Good.jpg",
              imageinfo: [{ thumburl: "https://example.com/good.jpg" }],
            },
            "-1": {
              title: "File:Missing.jpg",
              // No imageinfo at all
            },
            "2": {
              title: "File:Empty.jpg",
              imageinfo: [{ size: 100 }], // No url or thumburl
            },
          },
        },
      }),
    );

    const { fetchCommonsMetadata } = await loadModule();
    const result = await fetchCommonsMetadata(["Good.jpg", "Missing.jpg", "Empty.jpg"]);

    expect(result.size).toBe(1);
    expect(result.has("Good.jpg")).toBe(true);
  });

  it("handles spaces in filenames by converting to underscores for API", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ query: { pages: {} } }));

    const { fetchCommonsMetadata } = await loadModule();
    await fetchCommonsMetadata(["Berlin Sunset.jpg"]);

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("File%3ABerlin_Sunset.jpg");
  });

  it("returns empty Map when query.pages is missing", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ query: {} }));

    const { fetchCommonsMetadata } = await loadModule();
    const result = await fetchCommonsMetadata(["Test.jpg"]);
    expect(result.size).toBe(0);
  });
});
