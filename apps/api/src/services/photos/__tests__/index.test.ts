import type { PlacePhoto } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PhotoProvider } from "../types";

// Mock providers
const mockMapillary: PhotoProvider = {
  id: "mapillary",
  name: "Mapillary",
  search: vi.fn().mockResolvedValue([]),
};
const mockFlickr: PhotoProvider = {
  id: "flickr",
  name: "Flickr",
  search: vi.fn().mockResolvedValue([]),
};
const mockPanoramax: PhotoProvider = {
  id: "panoramax",
  name: "Panoramax",
  search: vi.fn().mockResolvedValue([]),
};
const mockWikimedia: PhotoProvider = {
  id: "wikimedia",
  name: "Wikimedia Commons",
  search: vi.fn().mockResolvedValue([]),
  searchByTags: vi.fn().mockResolvedValue([]),
};

// Safe reference — searchByTags is always defined on the mock above
const mockSearchByTags = vi.mocked(mockWikimedia.searchByTags as typeof mockWikimedia.search);

// Mock integration-host to return our fake integrations
vi.mock("../../../integration-host.js", () => ({
  getIntegrationsByDomain: vi.fn((domain: string) => {
    if (domain === "photos") {
      return [
        { providers: new Map([["photos", [mockWikimedia]]]) },
        { providers: new Map([["photos", [mockMapillary]]]) },
        { providers: new Map([["photos", [mockFlickr]]]) },
        { providers: new Map([["photos", [mockPanoramax]]]) },
      ];
    }
    return [];
  }),
}));

import { searchHeroPhotos, searchPhotos } from "../index.js";

function makePhoto(id: string, source: string, url?: string): PlacePhoto {
  return {
    url: url ?? `https://example.com/${id}.jpg`,
    attribution: `Photo ${id}`,
    source,
  };
}

beforeEach(() => {
  vi.mocked(mockMapillary.search).mockReset().mockResolvedValue([]);
  vi.mocked(mockFlickr.search).mockReset().mockResolvedValue([]);
  vi.mocked(mockPanoramax.search).mockReset().mockResolvedValue([]);
  vi.mocked(mockWikimedia.search).mockReset().mockResolvedValue([]);
  mockSearchByTags.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("searchPhotos", () => {
  const baseQuery = { lat: 48.85, lng: 2.35 };

  it("queries all 4 providers in parallel", async () => {
    await searchPhotos(baseQuery);

    expect(mockWikimedia.search).toHaveBeenCalledTimes(1);
    expect(mockMapillary.search).toHaveBeenCalledTimes(1);
    expect(mockFlickr.search).toHaveBeenCalledTimes(1);
    expect(mockPanoramax.search).toHaveBeenCalledTimes(1);
  });

  it("uses default limit=20 when none specified", async () => {
    await searchPhotos(baseQuery);

    // perProvider = Math.max(6, ceil(20/4)) = Math.max(6, 5) = 6
    expect(vi.mocked(mockMapillary.search)).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 6 }),
    );
  });

  it("computes perProvider = Math.max(6, ceil(totalLimit / 4)) with limit=20", async () => {
    await searchPhotos({ ...baseQuery, limit: 20 });

    // ceil(20/4) = 5, max(6, 5) = 6
    for (const provider of [mockMapillary, mockFlickr, mockPanoramax, mockWikimedia]) {
      expect(vi.mocked(provider.search)).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 6 }),
      );
    }
  });

  it("computes perProvider = Math.max(6, ceil(totalLimit / 4)) with limit=40", async () => {
    await searchPhotos({ ...baseQuery, limit: 40 });

    // ceil(40/4) = 10, max(6, 10) = 10
    for (const provider of [mockMapillary, mockFlickr, mockPanoramax, mockWikimedia]) {
      expect(vi.mocked(provider.search)).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10 }),
      );
    }
  });

  it("passes osmTags to providers in the query", async () => {
    const osmTags = { wikidata: "Q90", wikimedia_commons: "Category:Paris" };
    await searchPhotos({ ...baseQuery, osmTags });

    expect(vi.mocked(mockWikimedia.search)).toHaveBeenCalledWith(
      expect.objectContaining({ osmTags }),
    );
  });

  it("returns results from other providers when one fails", async () => {
    vi.mocked(mockMapillary.search).mockRejectedValue(new Error("timeout"));
    vi.mocked(mockFlickr.search).mockResolvedValue([makePhoto("f1", "flickr")]);
    vi.mocked(mockPanoramax.search).mockResolvedValue([makePhoto("p1", "panoramax")]);
    vi.mocked(mockWikimedia.search).mockResolvedValue([makePhoto("w1", "wikimedia")]);

    const results = await searchPhotos(baseQuery);

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.source)).toEqual(["wikimedia", "flickr", "panoramax"]);
  });

  it("returns [] when all providers fail", async () => {
    vi.mocked(mockMapillary.search).mockRejectedValue(new Error("fail"));
    vi.mocked(mockFlickr.search).mockRejectedValue(new Error("fail"));
    vi.mocked(mockPanoramax.search).mockRejectedValue(new Error("fail"));
    vi.mocked(mockWikimedia.search).mockRejectedValue(new Error("fail"));

    const results = await searchPhotos(baseQuery);

    expect(results).toEqual([]);
  });

  describe("deduplication", () => {
    it("deduplicates Wikimedia Special:FilePath with upload.wikimedia.org URLs", async () => {
      const photo1 = makePhoto(
        "wiki1",
        "wikimedia",
        "https://commons.wikimedia.org/wiki/Special:FilePath/Eiffel_Tower.jpg?width=800",
      );
      const photo2 = makePhoto(
        "wiki2",
        "wikimedia",
        "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Eiffel_Tower.jpg/800px-Eiffel_Tower.jpg",
      );

      vi.mocked(mockWikimedia.search).mockResolvedValue([photo1]);
      vi.mocked(mockFlickr.search).mockResolvedValue([photo2]);

      const results = await searchPhotos(baseQuery);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(photo1);
    });

    it("deduplicates same filename with different case (lowercase)", async () => {
      const photo1 = makePhoto(
        "wiki1",
        "wikimedia",
        "https://commons.wikimedia.org/wiki/Special:FilePath/TOWER.jpg?width=800",
      );
      const photo2 = makePhoto(
        "wiki2",
        "wikimedia",
        "https://upload.wikimedia.org/wikipedia/commons/a/ab/tower.jpg",
      );

      vi.mocked(mockWikimedia.search).mockResolvedValue([photo1]);
      vi.mocked(mockMapillary.search).mockResolvedValue([photo2]);

      const results = await searchPhotos(baseQuery);

      expect(results).toHaveLength(1);
    });

    it("decodes URL-encoded filenames before comparison", async () => {
      const photo1 = makePhoto(
        "wiki1",
        "wikimedia",
        "https://commons.wikimedia.org/wiki/Special:FilePath/Caf%C3%A9_Central.jpg?width=800",
      );
      const photo2 = makePhoto(
        "wiki2",
        "wikimedia",
        "https://upload.wikimedia.org/wikipedia/commons/a/ab/Caf%C3%A9_Central.jpg",
      );

      vi.mocked(mockWikimedia.search).mockResolvedValue([photo1]);
      vi.mocked(mockFlickr.search).mockResolvedValue([photo2]);

      const results = await searchPhotos(baseQuery);

      expect(results).toHaveLength(1);
    });

    it("enforces limit after dedup", async () => {
      const photos = Array.from({ length: 15 }, (_, i) => makePhoto(`p${i}`, "mapillary"));
      vi.mocked(mockMapillary.search).mockResolvedValue(photos);

      const results = await searchPhotos({ ...baseQuery, limit: 5 });

      expect(results).toHaveLength(5);
    });
  });
});

describe("searchHeroPhotos", () => {
  it("calls searchByTags on providers that support it", async () => {
    const photo = makePhoto("hero", "wikimedia");
    mockSearchByTags.mockResolvedValue([photo]);

    const results = await searchHeroPhotos({ wikimedia_commons: "Category:Paris" });

    expect(mockSearchByTags).toHaveBeenCalledWith({
      wikimedia_commons: "Category:Paris",
    });
    expect(results[0]).toEqual(photo);
  });

  it("does not call search() on providers, only searchByTags", async () => {
    await searchHeroPhotos({ wikimedia_commons: "Category:Paris" });

    expect(mockWikimedia.search).not.toHaveBeenCalled();
    expect(mockMapillary.search).not.toHaveBeenCalled();
  });

  it("limits results to 6", async () => {
    const photos = Array.from({ length: 10 }, (_, i) => makePhoto(`h${i}`, "wikimedia"));
    mockSearchByTags.mockResolvedValue(photos);

    const results = await searchHeroPhotos({ wikimedia_commons: "Category:Big" });

    expect(results).toHaveLength(6);
  });
});
