import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@integrations/enrichment-wikidata/provider.js", () => ({
  wikidataEnricher: { name: "wikidata", enrich: vi.fn() },
}));
vi.mock("@integrations/enrichment-wikipedia/provider.js", () => ({
  wikipediaEnricher: { name: "wikipedia", enrich: vi.fn() },
}));
vi.mock("../wikimedia-commons.enricher.js", () => ({
  wikimediaCommonsEnricher: { name: "wikimedia-commons", enrich: vi.fn() },
}));

let wikidataEnrich: ReturnType<typeof vi.fn>;
let wikipediaEnrich: ReturnType<typeof vi.fn>;
let wikimediaCommonsEnrich: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  const wd = await import("@integrations/enrichment-wikidata/provider.js");
  const wp = await import("@integrations/enrichment-wikipedia/provider.js");
  const wc = await import("../wikimedia-commons.enricher.js");
  wikidataEnrich = wd.wikidataEnricher.enrich as ReturnType<typeof vi.fn>;
  wikipediaEnrich = wp.wikipediaEnricher.enrich as ReturnType<typeof vi.fn>;
  wikimediaCommonsEnrich = wc.wikimediaCommonsEnricher.enrich as ReturnType<typeof vi.fn>;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makePlace(osmTags?: Record<string, string>) {
  return {
    id: "node/1",
    name: "Test",
    address: "Somewhere",
    coordinates: [13.4, 52.5] as [number, number],
    osmTags,
  };
}

describe("enrichPlace", () => {
  it("returns {} immediately when place has no osmTags", async () => {
    const { enrichPlace } = await import("../index.js");
    const result = await enrichPlace(makePlace(undefined));
    expect(result).toEqual({});
    expect(wikidataEnrich).not.toHaveBeenCalled();
    expect(wikipediaEnrich).not.toHaveBeenCalled();
    expect(wikimediaCommonsEnrich).not.toHaveBeenCalled();
  });

  it("scalar fields: first non-null description wins", async () => {
    wikidataEnrich.mockResolvedValueOnce({ description: "Wikidata desc" });
    wikipediaEnrich.mockResolvedValueOnce({ description: "Wikipedia desc" });
    wikimediaCommonsEnrich.mockResolvedValueOnce(null);

    const { enrichPlace } = await import("../index.js");
    const result = await enrichPlace(makePlace({ wikidata: "Q42" }));
    expect(result.description).toBe("Wikidata desc");
  });

  it("scalar fields: first non-null wikipediaUrl wins", async () => {
    wikidataEnrich.mockResolvedValueOnce({ wikipediaUrl: "https://en.wikipedia.org/wiki/A" });
    wikipediaEnrich.mockResolvedValueOnce({ wikipediaUrl: "https://en.wikipedia.org/wiki/B" });
    wikimediaCommonsEnrich.mockResolvedValueOnce(null);

    const { enrichPlace } = await import("../index.js");
    const result = await enrichPlace(makePlace({ wikidata: "Q42" }));
    expect(result.wikipediaUrl).toBe("https://en.wikipedia.org/wiki/A");
  });

  it("second source wins for description when first returns null", async () => {
    wikidataEnrich.mockResolvedValueOnce({ description: null });
    wikipediaEnrich.mockResolvedValueOnce({ description: "Wikipedia desc" });
    wikimediaCommonsEnrich.mockResolvedValueOnce(null);

    const { enrichPlace } = await import("../index.js");
    const result = await enrichPlace(makePlace({ wikidata: "Q42" }));
    expect(result.description).toBe("Wikipedia desc");
  });

  it("arrays: photos from all sources are concatenated", async () => {
    const photo1 = { url: "a.jpg", attribution: "A", source: "wikidata" };
    const photo2 = { url: "b.jpg", attribution: "B", source: "wikipedia" };
    const photo3 = { url: "c.jpg", attribution: "C", source: "wikimedia" };

    wikidataEnrich.mockResolvedValueOnce({ photos: [photo1] });
    wikipediaEnrich.mockResolvedValueOnce({ photos: [photo2] });
    wikimediaCommonsEnrich.mockResolvedValueOnce({ photos: [photo3] });

    const { enrichPlace } = await import("../index.js");
    const result = await enrichPlace(makePlace({ wikidata: "Q42" }));
    expect(result.photos).toEqual([photo1, photo2, photo3]);
  });

  it("arrays: facts from all sources are concatenated", async () => {
    const fact1 = { label: "Founded", value: "1870" };
    const fact2 = { label: "Population", value: "3,600,000" };

    wikidataEnrich.mockResolvedValueOnce({ facts: [fact1] });
    wikipediaEnrich.mockResolvedValueOnce({ facts: [fact2] });
    wikimediaCommonsEnrich.mockResolvedValueOnce(null);

    const { enrichPlace } = await import("../index.js");
    const result = await enrichPlace(makePlace({ wikidata: "Q42" }));
    expect(result.facts).toEqual([fact1, fact2]);
  });

  it("external IDs: merged, first value per key wins", async () => {
    wikidataEnrich.mockResolvedValueOnce({
      externalIds: { yelp: "biz-abc", foursquare: "venue-xyz" },
    });
    wikipediaEnrich.mockResolvedValueOnce({
      externalIds: { yelp: "biz-other", tripadvisor: "loc-123" },
    });
    wikimediaCommonsEnrich.mockResolvedValueOnce(null);

    const { enrichPlace } = await import("../index.js");
    const result = await enrichPlace(makePlace({ wikidata: "Q42" }));
    expect(result.externalIds).toEqual({
      yelp: "biz-abc",
      foursquare: "venue-xyz",
      tripadvisor: "loc-123",
    });
  });

  it("one enricher fails, others are still merged", async () => {
    wikidataEnrich.mockRejectedValueOnce(new Error("Wikidata down"));
    wikipediaEnrich.mockResolvedValueOnce({ description: "From Wikipedia" });
    wikimediaCommonsEnrich.mockResolvedValueOnce({
      photos: [{ url: "img.jpg", attribution: "CC", source: "wikimedia" }],
    });

    const { enrichPlace } = await import("../index.js");
    const result = await enrichPlace(makePlace({ wikidata: "Q42" }));
    expect(result.description).toBe("From Wikipedia");
    expect(result.photos).toHaveLength(1);
  });

  it("all enrichers fail → returns {}", async () => {
    wikidataEnrich.mockRejectedValueOnce(new Error("fail"));
    wikipediaEnrich.mockRejectedValueOnce(new Error("fail"));
    wikimediaCommonsEnrich.mockRejectedValueOnce(new Error("fail"));

    const { enrichPlace } = await import("../index.js");
    const result = await enrichPlace(makePlace({ wikidata: "Q42" }));
    expect(result).toEqual({});
  });

  it("all enrichers return null → returns {}", async () => {
    wikidataEnrich.mockResolvedValueOnce(null);
    wikipediaEnrich.mockResolvedValueOnce(null);
    wikimediaCommonsEnrich.mockResolvedValueOnce(null);

    const { enrichPlace } = await import("../index.js");
    const result = await enrichPlace(makePlace({ wikidata: "Q42" }));
    expect(result).toEqual({});
  });
});
