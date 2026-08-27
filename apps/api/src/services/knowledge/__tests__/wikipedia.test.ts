import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, streamedJsonResponse } from "../../../test/streamed-response.js";

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchCommonsMetadata: vi.fn() };
});

let mockFetch: ReturnType<typeof vi.fn>;
let mockFetchCommonsMetadata: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  const { fetchCommonsMetadata } = await import("@openmapx/core");
  mockFetchCommonsMetadata = fetchCommonsMetadata as unknown as ReturnType<typeof vi.fn>;
  mockFetchCommonsMetadata.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockOk(data: unknown) {
  return streamedJsonResponse(data);
}

function mockNotOk() {
  return emptyResponse();
}

function makeSummary(overrides: Record<string, unknown> = {}) {
  return {
    description: "City in Germany",
    content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Berlin" } },
    ...overrides,
  };
}

async function loadModule() {
  return import("@integrations/knowledge-wikipedia/provider.js");
}

describe("wikipediaSource", () => {
  it("returns null when no wikipedia tag", async () => {
    const { wikipediaSource } = await loadModule();
    const result = await wikipediaSource.lookup({ name: "Test" });
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('parses "en:Article Title" → lang="en", title="Article Title"', async () => {
    mockFetch.mockResolvedValueOnce(mockOk(makeSummary()));

    const { wikipediaSource } = await loadModule();
    await wikipediaSource.lookup({ wikipedia: "en:Berlin" }, "de");

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("en.wikipedia.org");
    expect(url).toContain("/Berlin");
  });

  it('no prefix → defaults to lang param ("de" → de.wikipedia.org)', async () => {
    mockFetch.mockResolvedValueOnce(mockOk(makeSummary()));

    const { wikipediaSource } = await loadModule();
    await wikipediaSource.lookup({ wikipedia: "Berlin" }, "de");

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("de.wikipedia.org");
  });

  it("defaults to en.wikipedia.org when no prefix and no lang", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(makeSummary()));

    const { wikipediaSource } = await loadModule();
    await wikipediaSource.lookup({ wikipedia: "Berlin" });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("en.wikipedia.org");
  });

  it("returns description and wikipediaUrl from REST v1 API", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk(
        makeSummary({
          description: "Capital of Germany",
          content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Berlin" } },
        }),
      ),
    );

    const { wikipediaSource } = await loadModule();
    const result = await wikipediaSource.lookup({ wikipedia: "en:Berlin" }, "en");
    expect(result?.description).toBe("Capital of Germany");
    expect(result?.wikipediaUrl).toBe("https://en.wikipedia.org/wiki/Berlin");
  });

  it("extracts image from originalimage.source, fetches commons metadata", async () => {
    const richPhoto = {
      url: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Berlin.jpg/800px-Berlin.jpg",
      author: "Author",
      license: "CC BY-SA 4.0",
      source: "wikimedia",
    };
    mockFetchCommonsMetadata.mockResolvedValueOnce(new Map([["Berlin.jpg", richPhoto]]));

    mockFetch.mockResolvedValueOnce(
      mockOk(
        makeSummary({
          originalimage: {
            source: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Berlin.jpg",
            width: 4000,
            height: 3000,
          },
        }),
      ),
    );

    const { wikipediaSource } = await loadModule();
    const result = await wikipediaSource.lookup({ wikipedia: "en:Berlin" }, "en");

    expect(mockFetchCommonsMetadata).toHaveBeenCalledWith(["Berlin.jpg"]);
    expect(result?.photos).toHaveLength(1);
    // Source is overridden to "wikipedia"
    expect(result?.photos?.[0].source).toBe("wikipedia");
  });

  it("falls back to thumbnail.source when no originalimage", async () => {
    mockFetchCommonsMetadata.mockResolvedValueOnce(new Map());

    mockFetch.mockResolvedValueOnce(
      mockOk(
        makeSummary({
          thumbnail: {
            source:
              "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Berlin.jpg/320px-Berlin.jpg",
            width: 320,
            height: 240,
          },
        }),
      ),
    );

    const { wikipediaSource } = await loadModule();
    const result = await wikipediaSource.lookup({ wikipedia: "en:Berlin" }, "en");

    // Falls back to thumbnail-based photo since commons metadata returns empty.
    // A filename WAS extractable from the thumb URL, so we still know the
    // Commons file page even though the metadata fetch failed.
    expect(result?.photos).toHaveLength(1);
    expect(result?.photos?.[0].source).toBe("wikipedia");
    expect(result?.photos?.[0].pageUrl).toBe("https://commons.wikimedia.org/wiki/File:Berlin.jpg");
    expect(result?.photos?.[0].author).toBeUndefined();
    expect(result?.photos?.[0].license).toBeUndefined();
  });

  it("creates fallback photo when filename cannot be extracted from URL", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk(
        makeSummary({
          originalimage: {
            source: "https://some-cdn.example.com/image.jpg",
            width: 800,
            height: 600,
          },
        }),
      ),
    );

    const { wikipediaSource } = await loadModule();
    const result = await wikipediaSource.lookup({ wikipedia: "en:Berlin" }, "en");
    expect(result?.photos).toHaveLength(1);
    expect(result?.photos?.[0].url).toBe("https://some-cdn.example.com/image.jpg");
    // No filename could be extracted, so we don't know the author, license, or
    // file page — none of those fields (nor a fabricated attribution) are set.
    expect(result?.photos?.[0].pageUrl).toBeUndefined();
    expect(result?.photos?.[0].author).toBeUndefined();
    expect(result?.photos?.[0].license).toBeUndefined();
    expect(mockFetchCommonsMetadata).not.toHaveBeenCalled();
  });

  it("returns null on API error", async () => {
    mockFetch.mockResolvedValueOnce(mockNotOk());

    const { wikipediaSource } = await loadModule();
    const result = await wikipediaSource.lookup({ wikipedia: "en:Berlin" }, "en");
    expect(result).toBeNull();
  });

  it("returns null when response has no extractable data", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({}));

    const { wikipediaSource } = await loadModule();
    const result = await wikipediaSource.lookup({ wikipedia: "en:Berlin" }, "en");
    expect(result).toBeNull();
  });

  it("encodes title with spaces as underscores in API URL", async () => {
    mockFetch.mockResolvedValueOnce(mockOk(makeSummary()));

    const { wikipediaSource } = await loadModule();
    await wikipediaSource.lookup({ wikipedia: "en:Brandenburg Gate" }, "en");

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("Brandenburg_Gate");
  });
});
