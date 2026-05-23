import type { KnowledgeProvider } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock knowledge sources
const mockWikidataSource: KnowledgeProvider = {
  name: "wikidata",
  lookup: vi.fn(),
};
const mockWikipediaSource: KnowledgeProvider = {
  name: "wikipedia",
  lookup: vi.fn(),
};

// Mock integration-host to return our fake integrations
vi.mock("../../../integration-host.js", () => ({
  getIntegrationsByDomain: vi.fn((domain: string) => {
    if (domain === "knowledge") {
      return [
        { providers: new Map([["knowledge", [mockWikidataSource]]]) },
        { providers: new Map([["knowledge", [mockWikipediaSource]]]) },
      ];
    }
    return [];
  }),
}));

let wikidataLookup: ReturnType<typeof vi.fn>;
let wikipediaLookup: ReturnType<typeof vi.fn>;

beforeEach(() => {
  wikidataLookup = mockWikidataSource.lookup as ReturnType<typeof vi.fn>;
  wikipediaLookup = mockWikipediaSource.lookup as ReturnType<typeof vi.fn>;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makePlace(osmTags?: Record<string, string>) {
  return {
    id: "osm:node/1",
    primaryScheme: "osm",
    ids: { osm: "node/1" },
    name: "Test",
    address: "Somewhere",
    coordinates: [13.4, 52.5] as [number, number],
    osmTags,
  };
}

describe("getPlaceKnowledge", () => {
  it("returns {} immediately when place has no osmTags", async () => {
    const { getPlaceKnowledge } = await import("../index.js");
    const result = await getPlaceKnowledge(makePlace(undefined));
    expect(result).toEqual({});
    expect(wikidataLookup).not.toHaveBeenCalled();
    expect(wikipediaLookup).not.toHaveBeenCalled();
  });

  it("scalar fields: first non-null description wins", async () => {
    wikidataLookup.mockResolvedValueOnce({ description: "Wikidata desc" });
    wikipediaLookup.mockResolvedValueOnce({ description: "Wikipedia desc" });

    const { getPlaceKnowledge } = await import("../index.js");
    const result = await getPlaceKnowledge(makePlace({ wikidata: "Q42" }));
    expect(result.description).toBe("Wikidata desc");
  });

  it("scalar fields: first non-null wikipediaUrl wins", async () => {
    wikidataLookup.mockResolvedValueOnce({ wikipediaUrl: "https://en.wikipedia.org/wiki/A" });
    wikipediaLookup.mockResolvedValueOnce({ wikipediaUrl: "https://en.wikipedia.org/wiki/B" });

    const { getPlaceKnowledge } = await import("../index.js");
    const result = await getPlaceKnowledge(makePlace({ wikidata: "Q42" }));
    expect(result.wikipediaUrl).toBe("https://en.wikipedia.org/wiki/A");
  });

  it("second source wins for description when first returns null", async () => {
    wikidataLookup.mockResolvedValueOnce({ description: null });
    wikipediaLookup.mockResolvedValueOnce({ description: "Wikipedia desc" });

    const { getPlaceKnowledge } = await import("../index.js");
    const result = await getPlaceKnowledge(makePlace({ wikidata: "Q42" }));
    expect(result.description).toBe("Wikipedia desc");
  });

  it("arrays: photos from all sources are concatenated", async () => {
    const photo1 = { url: "a.jpg", attribution: "A", source: "wikidata" };
    const photo2 = { url: "b.jpg", attribution: "B", source: "wikipedia" };

    wikidataLookup.mockResolvedValueOnce({ photos: [photo1] });
    wikipediaLookup.mockResolvedValueOnce({ photos: [photo2] });

    const { getPlaceKnowledge } = await import("../index.js");
    const result = await getPlaceKnowledge(makePlace({ wikidata: "Q42" }));
    expect(result.photos).toEqual([photo1, photo2]);
  });

  it("arrays: facts from all sources are concatenated", async () => {
    const fact1 = { label: "Founded", value: "1870" };
    const fact2 = { label: "Population", value: "3,600,000" };

    wikidataLookup.mockResolvedValueOnce({ facts: [fact1] });
    wikipediaLookup.mockResolvedValueOnce({ facts: [fact2] });

    const { getPlaceKnowledge } = await import("../index.js");
    const result = await getPlaceKnowledge(makePlace({ wikidata: "Q42" }));
    expect(result.facts).toEqual([fact1, fact2]);
  });

  it("external IDs: merged, first value per key wins", async () => {
    wikidataLookup.mockResolvedValueOnce({
      externalIds: { yelp: "biz-abc", google_maps: "123456" },
    });
    wikipediaLookup.mockResolvedValueOnce({
      externalIds: { yelp: "biz-other", tripadvisor: "loc-123" },
    });

    const { getPlaceKnowledge } = await import("../index.js");
    const result = await getPlaceKnowledge(makePlace({ wikidata: "Q42" }));
    expect(result.externalIds).toEqual({
      yelp: "biz-abc",
      google_maps: "123456",
      tripadvisor: "loc-123",
    });
  });

  it("one source fails, others are still merged", async () => {
    wikidataLookup.mockRejectedValueOnce(new Error("Wikidata down"));
    wikipediaLookup.mockResolvedValueOnce({ description: "From Wikipedia" });

    const { getPlaceKnowledge } = await import("../index.js");
    const result = await getPlaceKnowledge(makePlace({ wikidata: "Q42" }));
    expect(result.description).toBe("From Wikipedia");
  });

  it("all sources fail → returns {}", async () => {
    wikidataLookup.mockRejectedValueOnce(new Error("fail"));
    wikipediaLookup.mockRejectedValueOnce(new Error("fail"));

    const { getPlaceKnowledge } = await import("../index.js");
    const result = await getPlaceKnowledge(makePlace({ wikidata: "Q42" }));
    expect(result).toEqual({});
  });

  it("all sources return null → returns {}", async () => {
    wikidataLookup.mockResolvedValueOnce(null);
    wikipediaLookup.mockResolvedValueOnce(null);

    const { getPlaceKnowledge } = await import("../index.js");
    const result = await getPlaceKnowledge(makePlace({ wikidata: "Q42" }));
    expect(result).toEqual({});
  });
});
