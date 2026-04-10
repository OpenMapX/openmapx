import type { PlacePhoto } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, parseCommonsPage: vi.fn() };
});

import { parseCommonsPage } from "@openmapx/core";

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  vi.mocked(parseCommonsPage).mockReset();
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

function makePage(title: string, overrides: { imageinfo?: Record<string, unknown> } = {}) {
  const { imageinfo: iiOverrides, ...rest } = overrides as Record<string, unknown>;
  return {
    title: `File:${title}`,
    imageinfo: [
      {
        url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${title}`,
        thumburl: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${title}/800px-${title}`,
        size: 500000,
        width: 1200,
        height: 900,
        ...((iiOverrides as Record<string, unknown>) ?? {}),
      },
    ],
    coordinates: [{ lat: 48.85, lon: 2.35 }],
    ...rest,
  };
}

function makeApiResponse(pages: Record<string, unknown>) {
  return { query: { pages } };
}

function mockPhoto(id: string): PlacePhoto {
  return {
    url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${id}.jpg`,
    attribution: `Wikimedia Commons (CC BY-SA)`,
    source: "wikimedia",
  };
}

async function loadModule() {
  return import("@integrations/photos-wikimedia/provider.js");
}

describe("wikimediaProvider", () => {
  describe("rejected extensions", () => {
    const rejectedExts = [
      ".svg",
      ".pdf",
      ".ogg",
      ".ogv",
      ".webm",
      ".tiff",
      ".tif",
      ".djvu",
      ".xcf",
      ".stl",
      ".gif",
    ];

    for (const ext of rejectedExts) {
      it(`filters out ${ext} files`, async () => {
        const { wikimediaProvider } = await loadModule();
        const filename = `TestFile${ext}`;
        mockFetch.mockResolvedValue(mockOk(makeApiResponse({ "1": makePage(filename) })));
        vi.mocked(parseCommonsPage).mockReturnValue(mockPhoto("test"));

        const results = await wikimediaProvider.search({ lat: 48.85, lng: 2.35 });

        expect(results).toEqual([]);
        expect(parseCommonsPage).not.toHaveBeenCalled();
      });
    }

    it("filters case-insensitively (e.g., .SVG)", async () => {
      const { wikimediaProvider } = await loadModule();
      mockFetch.mockResolvedValue(mockOk(makeApiResponse({ "1": makePage("Diagram.SVG") })));
      vi.mocked(parseCommonsPage).mockReturnValue(mockPhoto("test"));

      const results = await wikimediaProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results).toEqual([]);
    });

    it("allows valid photo extensions like .jpg", async () => {
      const { wikimediaProvider } = await loadModule();
      const photo = mockPhoto("good");
      mockFetch.mockResolvedValue(mockOk(makeApiResponse({ "1": makePage("Photo.jpg") })));
      vi.mocked(parseCommonsPage).mockReturnValue(photo);

      const results = await wikimediaProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results).toEqual([photo]);
    });

    it("allows .png files", async () => {
      const { wikimediaProvider } = await loadModule();
      const photo = mockPhoto("good");
      mockFetch.mockResolvedValue(mockOk(makeApiResponse({ "1": makePage("Image.png") })));
      vi.mocked(parseCommonsPage).mockReturnValue(photo);

      const results = await wikimediaProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results).toEqual([photo]);
    });
  });

  describe("file size filter", () => {
    it("filters out files larger than 50MB", async () => {
      const { wikimediaProvider } = await loadModule();
      const largeSize = 50 * 1024 * 1024 + 1;
      mockFetch.mockResolvedValue(
        mockOk(
          makeApiResponse({
            "1": makePage("Large.jpg", {
              imageinfo: { size: largeSize, width: 4000, height: 3000 },
            }),
          }),
        ),
      );
      vi.mocked(parseCommonsPage).mockReturnValue(mockPhoto("test"));

      const results = await wikimediaProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results).toEqual([]);
      expect(parseCommonsPage).not.toHaveBeenCalled();
    });

    it("allows files exactly at 50MB", async () => {
      const { wikimediaProvider } = await loadModule();
      const exactSize = 50 * 1024 * 1024;
      const photo = mockPhoto("exact");
      mockFetch.mockResolvedValue(
        mockOk(
          makeApiResponse({
            "1": makePage("Exact.jpg", {
              imageinfo: { size: exactSize, width: 4000, height: 3000 },
            }),
          }),
        ),
      );
      vi.mocked(parseCommonsPage).mockReturnValue(photo);

      const results = await wikimediaProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results).toEqual([photo]);
    });
  });

  describe("dimension filter", () => {
    it("filters out images with width > 8000px", async () => {
      const { wikimediaProvider } = await loadModule();
      mockFetch.mockResolvedValue(
        mockOk(
          makeApiResponse({
            "1": makePage("Wide.jpg", { imageinfo: { size: 1000, width: 8001, height: 4000 } }),
          }),
        ),
      );
      vi.mocked(parseCommonsPage).mockReturnValue(mockPhoto("test"));

      const results = await wikimediaProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results).toEqual([]);
    });

    it("filters out images with height > 8000px", async () => {
      const { wikimediaProvider } = await loadModule();
      mockFetch.mockResolvedValue(
        mockOk(
          makeApiResponse({
            "1": makePage("Tall.jpg", { imageinfo: { size: 1000, width: 4000, height: 8001 } }),
          }),
        ),
      );
      vi.mocked(parseCommonsPage).mockReturnValue(mockPhoto("test"));

      const results = await wikimediaProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results).toEqual([]);
    });

    it("allows images exactly at 8000px width", async () => {
      const { wikimediaProvider } = await loadModule();
      const photo = mockPhoto("exact-dim");
      mockFetch.mockResolvedValue(
        mockOk(
          makeApiResponse({
            "1": makePage("Exact.jpg", { imageinfo: { size: 1000, width: 8000, height: 6000 } }),
          }),
        ),
      );
      vi.mocked(parseCommonsPage).mockReturnValue(photo);

      const results = await wikimediaProvider.search({ lat: 48.85, lng: 2.35 });

      expect(results).toEqual([photo]);
    });
  });

  it("passes valid files through parseCommonsPage", async () => {
    const { wikimediaProvider } = await loadModule();
    const photo1 = mockPhoto("photo1");
    const photo2 = mockPhoto("photo2");
    const page1 = makePage("Photo1.jpg");
    const page2 = makePage("Photo2.jpg");
    mockFetch.mockResolvedValue(mockOk(makeApiResponse({ "1": page1, "2": page2 })));
    vi.mocked(parseCommonsPage).mockReturnValueOnce(photo1).mockReturnValueOnce(photo2);

    const results = await wikimediaProvider.search({ lat: 48.85, lng: 2.35 });

    expect(parseCommonsPage).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
  });

  it("skips pages where parseCommonsPage returns undefined", async () => {
    const { wikimediaProvider } = await loadModule();
    const photo = mockPhoto("good");
    mockFetch.mockResolvedValue(
      mockOk(
        makeApiResponse({
          "1": makePage("Good.jpg"),
          "2": makePage("NoInfo.jpg"),
        }),
      ),
    );
    vi.mocked(parseCommonsPage).mockReturnValueOnce(photo).mockReturnValueOnce(undefined);

    const results = await wikimediaProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results).toEqual([photo]);
  });

  describe("API request parameters", () => {
    it("sets ggsradius=500 in the request", async () => {
      const { wikimediaProvider } = await loadModule();
      mockFetch.mockResolvedValue(mockOk({ query: { pages: {} } }));

      await wikimediaProvider.search({ lat: 48.85, lng: 2.35 });

      const fetchUrl = new URL(mockFetch.mock.calls[0][0] as string);
      expect(fetchUrl.searchParams.get("ggsradius")).toBe("500");
    });

    it("sets ggsnamespace=6 in the request", async () => {
      const { wikimediaProvider } = await loadModule();
      mockFetch.mockResolvedValue(mockOk({ query: { pages: {} } }));

      await wikimediaProvider.search({ lat: 48.85, lng: 2.35 });

      const fetchUrl = new URL(mockFetch.mock.calls[0][0] as string);
      expect(fetchUrl.searchParams.get("ggsnamespace")).toBe("6");
    });

    it("sets ggscoord with lat|lng", async () => {
      const { wikimediaProvider } = await loadModule();
      mockFetch.mockResolvedValue(mockOk({ query: { pages: {} } }));

      await wikimediaProvider.search({ lat: 52.52, lng: 13.405 });

      const fetchUrl = new URL(mockFetch.mock.calls[0][0] as string);
      expect(fetchUrl.searchParams.get("ggscoord")).toBe("52.52|13.405");
    });
  });

  it("returns [] on HTTP error", async () => {
    const { wikimediaProvider } = await loadModule();
    mockFetch.mockResolvedValue(mockNotOk(500));

    const results = await wikimediaProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results).toEqual([]);
  });

  it("returns [] on network error (fetch throws)", async () => {
    const { wikimediaProvider } = await loadModule();
    mockFetch.mockRejectedValue(new Error("Network error"));

    const results = await wikimediaProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results).toEqual([]);
  });

  it("returns [] when pages is undefined (empty response)", async () => {
    const { wikimediaProvider } = await loadModule();
    mockFetch.mockResolvedValue(mockOk({}));

    const results = await wikimediaProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results).toEqual([]);
  });

  it("returns [] when pages is empty object", async () => {
    const { wikimediaProvider } = await loadModule();
    mockFetch.mockResolvedValue(mockOk({ query: { pages: {} } }));

    const results = await wikimediaProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results).toEqual([]);
  });

  it("skips pages with no imageinfo", async () => {
    const { wikimediaProvider } = await loadModule();
    mockFetch.mockResolvedValue(
      mockOk(
        makeApiResponse({
          "1": { title: "File:NoInfo.jpg" },
        }),
      ),
    );

    const results = await wikimediaProvider.search({ lat: 48.85, lng: 2.35 });

    expect(results).toEqual([]);
    expect(parseCommonsPage).not.toHaveBeenCalled();
  });
});
