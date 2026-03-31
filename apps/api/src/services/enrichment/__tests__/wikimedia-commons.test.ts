import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchCommonsMetadata: vi.fn(), parseCommonsPage: vi.fn() };
});

let mockFetch: ReturnType<typeof vi.fn>;
let mockFetchCommonsMetadata: ReturnType<typeof vi.fn>;
let mockParseCommonsPage: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  const core = await import("@openmapx/core");
  mockFetchCommonsMetadata = core.fetchCommonsMetadata as unknown as ReturnType<typeof vi.fn>;
  mockParseCommonsPage = core.parseCommonsPage as unknown as ReturnType<typeof vi.fn>;
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

function makePhoto(url: string) {
  return {
    url,
    attribution: "Author / Wikimedia Commons (CC BY-SA 4.0)",
    source: "wikimedia",
  };
}

async function loadModule() {
  return import("@integrations/enrichment-wikimedia-commons/provider.js");
}

describe("wikimediaCommonsEnricher", () => {
  it("returns null when no wikimedia_commons tag", async () => {
    const { wikimediaCommonsEnricher } = await loadModule();
    const result = await wikimediaCommonsEnricher.enrich({ name: "Test" });
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('"File:Name.jpg" → single file mode, calls fetchCommonsMetadata([filename])', async () => {
    const richPhoto = makePhoto("https://upload.wikimedia.org/commons/a/ab/Sunset.jpg");
    mockFetchCommonsMetadata.mockResolvedValueOnce(new Map([["Sunset.jpg", richPhoto]]));

    const { wikimediaCommonsEnricher } = await loadModule();
    const result = await wikimediaCommonsEnricher.enrich({
      wikimedia_commons: "File:Sunset.jpg",
    });

    expect(mockFetchCommonsMetadata).toHaveBeenCalledWith(["Sunset.jpg"]);
    expect(result?.photos).toEqual([richPhoto]);
    // Should NOT call the category API
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("File mode: falls back to constructed URL when metadata fails", async () => {
    mockFetchCommonsMetadata.mockResolvedValueOnce(new Map());

    const { wikimediaCommonsEnricher } = await loadModule();
    const result = await wikimediaCommonsEnricher.enrich({
      wikimedia_commons: "File:Berlin Skyline.jpg",
    });

    expect(result?.photos).toHaveLength(1);
    expect(result?.photos?.[0].url).toContain("Special:FilePath/Berlin_Skyline.jpg");
    expect(result?.photos?.[0].attribution).toBe("© Wikimedia Commons (CC BY-SA)");
  });

  it('"Category:Name" → category mode, fetches category members via API', async () => {
    const photo1 = makePhoto("https://example.com/1.jpg");
    const photo2 = makePhoto("https://example.com/2.jpg");

    mockParseCommonsPage.mockReturnValueOnce(photo1);
    mockParseCommonsPage.mockReturnValueOnce(photo2);

    mockFetch.mockResolvedValueOnce(
      mockOk({
        query: {
          pages: {
            "1": { title: "File:A.jpg", imageinfo: [{ thumburl: "a.jpg" }] },
            "2": { title: "File:B.jpg", imageinfo: [{ thumburl: "b.jpg" }] },
          },
        },
      }),
    );

    const { wikimediaCommonsEnricher } = await loadModule();
    const result = await wikimediaCommonsEnricher.enrich({
      wikimedia_commons: "Category:Berlin",
    });

    expect(result?.photos).toEqual([photo1, photo2]);

    // Verify API URL includes category parameters
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("gcmtitle=Category%3ABerlin");
    expect(url).toContain("gcmtype=file");
    expect(url).toContain("gcmlimit=6");
  });

  it('no prefix → treated as category (prepends "Category:")', async () => {
    mockParseCommonsPage.mockReturnValueOnce(makePhoto("https://example.com/1.jpg"));

    mockFetch.mockResolvedValueOnce(
      mockOk({
        query: {
          pages: {
            "1": { title: "File:A.jpg", imageinfo: [{ thumburl: "a.jpg" }] },
          },
        },
      }),
    );

    const { wikimediaCommonsEnricher } = await loadModule();
    await wikimediaCommonsEnricher.enrich({ wikimedia_commons: "Berlin" });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("gcmtitle=Category%3ABerlin");
  });

  it("returns null when category has no parseable pages", async () => {
    mockParseCommonsPage.mockReturnValue(undefined);

    mockFetch.mockResolvedValueOnce(
      mockOk({
        query: {
          pages: {
            "1": { title: "File:A.jpg" },
          },
        },
      }),
    );

    const { wikimediaCommonsEnricher } = await loadModule();
    const result = await wikimediaCommonsEnricher.enrich({
      wikimedia_commons: "Category:Empty",
    });
    expect(result).toBeNull();
  });

  it("limits to 6 photos per category (MAX_PHOTOS)", async () => {
    const pages: Record<string, unknown> = {};
    for (let i = 0; i < 6; i++) {
      pages[String(i)] = { title: `File:${i}.jpg`, imageinfo: [{ thumburl: `${i}.jpg` }] };
      mockParseCommonsPage.mockReturnValueOnce(makePhoto(`https://example.com/${i}.jpg`));
    }

    mockFetch.mockResolvedValueOnce(mockOk({ query: { pages } }));

    const { wikimediaCommonsEnricher } = await loadModule();
    const result = await wikimediaCommonsEnricher.enrich({
      wikimedia_commons: "Category:Big",
    });

    expect(result?.photos).toHaveLength(6);

    // Verify the API request limits to 6
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("gcmlimit=6");
  });

  it("returns null on API error", async () => {
    mockFetch.mockResolvedValueOnce(mockNotOk());

    const { wikimediaCommonsEnricher } = await loadModule();
    const result = await wikimediaCommonsEnricher.enrich({
      wikimedia_commons: "Category:Berlin",
    });
    expect(result).toBeNull();
  });

  it("returns null when fetch throws (timeout)", async () => {
    mockFetch.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));

    const { wikimediaCommonsEnricher } = await loadModule();
    const result = await wikimediaCommonsEnricher.enrich({
      wikimedia_commons: "Category:Berlin",
    });
    expect(result).toBeNull();
  });

  it("trims whitespace from tag value", async () => {
    mockFetchCommonsMetadata.mockResolvedValueOnce(new Map([["Test.jpg", makePhoto("t.jpg")]]));

    const { wikimediaCommonsEnricher } = await loadModule();
    const result = await wikimediaCommonsEnricher.enrich({
      wikimedia_commons: "  File:Test.jpg  ",
    });
    expect(mockFetchCommonsMetadata).toHaveBeenCalledWith(["Test.jpg"]);
    expect(result?.photos).toHaveLength(1);
  });
});
