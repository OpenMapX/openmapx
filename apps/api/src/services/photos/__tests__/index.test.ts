import type { PlacePhoto } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock all 4 providers
vi.mock("../mapillary.provider.js", () => ({
  mapillaryPhotoProvider: {
    id: "mapillary",
    name: "Mapillary",
    search: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("../flickr.provider.js", () => ({
  flickrPhotoProvider: {
    id: "flickr",
    name: "Flickr",
    search: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("../panoramax.provider.js", () => ({
  panoramaxPhotoProvider: {
    id: "panoramax",
    name: "Panoramax",
    search: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("../wikimedia-geo.provider.js", () => ({
  wikimediaGeoProvider: {
    id: "wikimedia-geo",
    name: "Wikimedia Commons",
    search: vi.fn().mockResolvedValue([]),
  },
}));

// Mock 3 enrichers
vi.mock("../../enrichment/wikidata.enricher.js", () => ({
  wikidataEnricher: {
    name: "wikidata",
    enrich: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock("../../enrichment/wikipedia.enricher.js", () => ({
  wikipediaEnricher: {
    name: "wikipedia",
    enrich: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock("../../enrichment/wikimedia-commons.enricher.js", () => ({
  wikimediaCommonsEnricher: {
    name: "wikimedia-commons",
    enrich: vi.fn().mockResolvedValue(null),
  },
}));

import { wikidataEnricher } from "../../enrichment/wikidata.enricher.js";
import { wikimediaCommonsEnricher } from "../../enrichment/wikimedia-commons.enricher.js";
import { wikipediaEnricher } from "../../enrichment/wikipedia.enricher.js";
import { flickrPhotoProvider } from "../flickr.provider.js";
import { searchPhotos } from "../index.js";
import { mapillaryPhotoProvider } from "../mapillary.provider.js";
import { panoramaxPhotoProvider } from "../panoramax.provider.js";
import { wikimediaGeoProvider } from "../wikimedia-geo.provider.js";

function makePhoto(id: string, source: string, url?: string): PlacePhoto {
  return {
    url: url ?? `https://example.com/${id}.jpg`,
    attribution: `Photo ${id}`,
    source,
  };
}

beforeEach(() => {
  vi.mocked(mapillaryPhotoProvider.search).mockReset().mockResolvedValue([]);
  vi.mocked(flickrPhotoProvider.search).mockReset().mockResolvedValue([]);
  vi.mocked(panoramaxPhotoProvider.search).mockReset().mockResolvedValue([]);
  vi.mocked(wikimediaGeoProvider.search).mockReset().mockResolvedValue([]);
  vi.mocked(wikidataEnricher.enrich).mockReset().mockResolvedValue(null);
  vi.mocked(wikipediaEnricher.enrich).mockReset().mockResolvedValue(null);
  vi.mocked(wikimediaCommonsEnricher.enrich).mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("searchPhotos", () => {
  const baseQuery = { lat: 48.85, lng: 2.35 };

  it("queries all 4 providers in parallel", async () => {
    await searchPhotos(baseQuery);

    expect(wikimediaGeoProvider.search).toHaveBeenCalledTimes(1);
    expect(mapillaryPhotoProvider.search).toHaveBeenCalledTimes(1);
    expect(flickrPhotoProvider.search).toHaveBeenCalledTimes(1);
    expect(panoramaxPhotoProvider.search).toHaveBeenCalledTimes(1);
  });

  it("uses default limit=20 when none specified", async () => {
    await searchPhotos(baseQuery);

    // perProvider = Math.max(6, ceil(20/4)) = Math.max(6, 5) = 6
    expect(vi.mocked(mapillaryPhotoProvider.search)).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 6 }),
    );
  });

  it("computes perProvider = Math.max(6, ceil(totalLimit / 4)) with limit=20", async () => {
    await searchPhotos({ ...baseQuery, limit: 20 });

    // ceil(20/4) = 5, max(6, 5) = 6
    for (const provider of [
      mapillaryPhotoProvider,
      flickrPhotoProvider,
      panoramaxPhotoProvider,
      wikimediaGeoProvider,
    ]) {
      expect(vi.mocked(provider.search)).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 6 }),
      );
    }
  });

  it("computes perProvider = Math.max(6, ceil(totalLimit / 4)) with limit=40", async () => {
    await searchPhotos({ ...baseQuery, limit: 40 });

    // ceil(40/4) = 10, max(6, 10) = 10
    for (const provider of [
      mapillaryPhotoProvider,
      flickrPhotoProvider,
      panoramaxPhotoProvider,
      wikimediaGeoProvider,
    ]) {
      expect(vi.mocked(provider.search)).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10 }),
      );
    }
  });

  it("places enricher photos FIRST (hero image at index 0)", async () => {
    const enricherPhoto = makePhoto("enricher-hero", "wikidata");
    const providerPhoto = makePhoto("provider-1", "mapillary");

    vi.mocked(wikidataEnricher.enrich).mockResolvedValue({
      photos: [enricherPhoto],
    });
    vi.mocked(mapillaryPhotoProvider.search).mockResolvedValue([providerPhoto]);

    const results = await searchPhotos({
      ...baseQuery,
      osmTags: { wikidata: "Q90" },
    });

    expect(results[0]).toEqual(enricherPhoto);
    expect(results[1]).toEqual(providerPhoto);
  });

  it("runs tag enrichers only when osmTags provided", async () => {
    await searchPhotos({ ...baseQuery, osmTags: { wikidata: "Q90" } });

    expect(wikidataEnricher.enrich).toHaveBeenCalledTimes(1);
    expect(wikipediaEnricher.enrich).toHaveBeenCalledTimes(1);
    expect(wikimediaCommonsEnricher.enrich).toHaveBeenCalledTimes(1);
  });

  it("does NOT run enrichers when osmTags not provided", async () => {
    await searchPhotos(baseQuery);

    expect(wikidataEnricher.enrich).not.toHaveBeenCalled();
    expect(wikipediaEnricher.enrich).not.toHaveBeenCalled();
    expect(wikimediaCommonsEnricher.enrich).not.toHaveBeenCalled();
  });

  it("returns results from other providers when one fails", async () => {
    vi.mocked(mapillaryPhotoProvider.search).mockRejectedValue(new Error("timeout"));
    vi.mocked(flickrPhotoProvider.search).mockResolvedValue([makePhoto("f1", "flickr")]);
    vi.mocked(panoramaxPhotoProvider.search).mockResolvedValue([makePhoto("p1", "panoramax")]);
    vi.mocked(wikimediaGeoProvider.search).mockResolvedValue([makePhoto("w1", "wikimedia")]);

    const results = await searchPhotos(baseQuery);

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.source)).toEqual(["wikimedia", "flickr", "panoramax"]);
  });

  it("returns [] when all providers fail", async () => {
    vi.mocked(mapillaryPhotoProvider.search).mockRejectedValue(new Error("fail"));
    vi.mocked(flickrPhotoProvider.search).mockRejectedValue(new Error("fail"));
    vi.mocked(panoramaxPhotoProvider.search).mockRejectedValue(new Error("fail"));
    vi.mocked(wikimediaGeoProvider.search).mockRejectedValue(new Error("fail"));

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

      vi.mocked(wikimediaGeoProvider.search).mockResolvedValue([photo1]);
      vi.mocked(flickrPhotoProvider.search).mockResolvedValue([photo2]);

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

      vi.mocked(wikimediaGeoProvider.search).mockResolvedValue([photo1]);
      vi.mocked(mapillaryPhotoProvider.search).mockResolvedValue([photo2]);

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

      vi.mocked(wikimediaGeoProvider.search).mockResolvedValue([photo1]);
      vi.mocked(flickrPhotoProvider.search).mockResolvedValue([photo2]);

      const results = await searchPhotos(baseQuery);

      expect(results).toHaveLength(1);
    });

    it("enforces limit after dedup", async () => {
      const photos = Array.from({ length: 15 }, (_, i) => makePhoto(`p${i}`, "mapillary"));
      vi.mocked(mapillaryPhotoProvider.search).mockResolvedValue(photos);

      const results = await searchPhotos({ ...baseQuery, limit: 5 });

      expect(results).toHaveLength(5);
    });
  });
});
