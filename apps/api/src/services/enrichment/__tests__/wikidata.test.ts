import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../commons-metadata.js", () => ({
  fetchCommonsMetadata: vi.fn(),
}));

let mockFetch: ReturnType<typeof vi.fn>;
let mockFetchCommonsMetadata: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  const cm = await import("../commons-metadata.js");
  mockFetchCommonsMetadata = cm.fetchCommonsMetadata as ReturnType<typeof vi.fn>;
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

function makeEntity(overrides: Record<string, unknown> = {}) {
  return {
    descriptions: {},
    claims: {},
    sitelinks: {},
    ...overrides,
  };
}

function makeWdResponse(qid: string, entity: Record<string, unknown>) {
  return { entities: { [qid]: entity } };
}

async function loadModule() {
  return import("../wikidata.enricher.js");
}

describe("wikidataEnricher", () => {
  it("returns null when no wikidata tag", async () => {
    const { wikidataEnricher } = await loadModule();
    const result = await wikidataEnricher.enrich({ name: "Test" });
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("extracts description from entity.descriptions[lang].value and capitalizes first letter", async () => {
    const entity = makeEntity({
      descriptions: { en: { value: "large city in Germany" } },
    });
    mockFetch.mockResolvedValueOnce(mockOk(makeWdResponse("Q64", entity)));

    const { wikidataEnricher } = await loadModule();
    const result = await wikidataEnricher.enrich({ wikidata: "Q64" }, "en");
    expect(result?.description).toBe("Large city in Germany");
  });

  it("builds Wikipedia URL from sitelinks[langwiki].title", async () => {
    const entity = makeEntity({
      sitelinks: { enwiki: { title: "Berlin" } },
    });
    mockFetch.mockResolvedValueOnce(mockOk(makeWdResponse("Q64", entity)));

    const { wikidataEnricher } = await loadModule();
    const result = await wikidataEnricher.enrich({ wikidata: "Q64" }, "en");
    expect(result?.wikipediaUrl).toBe("https://en.wikipedia.org/wiki/Berlin");
  });

  it("encodes spaces as underscores in Wikipedia URL", async () => {
    const entity = makeEntity({
      sitelinks: { enwiki: { title: "Brandenburg Gate" } },
    });
    mockFetch.mockResolvedValueOnce(mockOk(makeWdResponse("Q82425", entity)));

    const { wikidataEnricher } = await loadModule();
    const result = await wikidataEnricher.enrich({ wikidata: "Q82425" }, "en");
    expect(result?.wikipediaUrl).toBe("https://en.wikipedia.org/wiki/Brandenburg_Gate");
  });

  it("fetches P18 main image via fetchCommonsMetadata", async () => {
    const richPhoto = {
      url: "https://commons.wikimedia.org/wiki/Special:FilePath/Berlin.jpg?width=800",
      attribution: "Author / Wikimedia Commons (CC BY-SA 4.0)",
      source: "wikimedia",
    };
    const metadataMap = new Map([["Berlin.jpg", richPhoto]]);
    mockFetchCommonsMetadata.mockResolvedValueOnce(metadataMap);

    const entity = makeEntity({
      claims: {
        P18: [
          {
            rank: "normal",
            mainsnak: {
              snaktype: "value",
              datavalue: { type: "string", value: "Berlin.jpg" },
            },
          },
        ],
      },
    });
    mockFetch.mockResolvedValueOnce(mockOk(makeWdResponse("Q64", entity)));

    const { wikidataEnricher } = await loadModule();
    const result = await wikidataEnricher.enrich({ wikidata: "Q64" }, "en");
    expect(mockFetchCommonsMetadata).toHaveBeenCalledWith(["Berlin.jpg"]);
    expect(result?.photos).toEqual([richPhoto]);
  });

  it("falls back to constructed URL if fetchCommonsMetadata returns no match", async () => {
    mockFetchCommonsMetadata.mockResolvedValueOnce(new Map());

    const entity = makeEntity({
      claims: {
        P18: [
          {
            rank: "normal",
            mainsnak: {
              snaktype: "value",
              datavalue: { type: "string", value: "Some_Image.jpg" },
            },
          },
        ],
      },
    });
    mockFetch.mockResolvedValueOnce(mockOk(makeWdResponse("Q64", entity)));

    const { wikidataEnricher } = await loadModule();
    const result = await wikidataEnricher.enrich({ wikidata: "Q64" }, "en");
    expect(result?.photos).toHaveLength(1);
    expect(result?.photos?.[0].url).toContain("Special:FilePath/Some_Image.jpg");
    expect(result?.photos?.[0].attribution).toBe("© Wikimedia Commons (CC BY-SA)");
  });

  it("formats time: '+1870-01-01T00:00:00Z' → '1870'", async () => {
    const entity = makeEntity({
      claims: {
        P571: [
          {
            rank: "normal",
            mainsnak: {
              snaktype: "value",
              datavalue: {
                type: "time",
                value: { time: "+1870-01-01T00:00:00Z", precision: 9 },
              },
            },
          },
        ],
      },
    });
    mockFetch.mockResolvedValueOnce(mockOk(makeWdResponse("Q64", entity)));

    const { wikidataEnricher } = await loadModule();
    const result = await wikidataEnricher.enrich({ wikidata: "Q64" }, "en");
    const founded = result?.facts?.find((f) => f.label === "Founded");
    expect(founded?.value).toBe("1870");
  });

  it("formats BCE time: '-0356-01-01T00:00:00Z' → '356 BCE'", async () => {
    const entity = makeEntity({
      claims: {
        P571: [
          {
            rank: "normal",
            mainsnak: {
              snaktype: "value",
              datavalue: {
                type: "time",
                value: { time: "-0356-01-01T00:00:00Z", precision: 9 },
              },
            },
          },
        ],
      },
    });
    mockFetch.mockResolvedValueOnce(mockOk(makeWdResponse("Q64", entity)));

    const { wikidataEnricher } = await loadModule();
    const result = await wikidataEnricher.enrich({ wikidata: "Q64" }, "en");
    const founded = result?.facts?.find((f) => f.label === "Founded");
    expect(founded?.value).toBe("356 BCE");
  });

  it("formats quantity with locale", async () => {
    const entity = makeEntity({
      claims: {
        P1082: [
          {
            rank: "normal",
            mainsnak: {
              snaktype: "value",
              datavalue: {
                type: "quantity",
                value: { amount: "+3645000" },
              },
            },
          },
        ],
      },
    });
    mockFetch.mockResolvedValueOnce(mockOk(makeWdResponse("Q64", entity)));

    const { wikidataEnricher } = await loadModule();
    const result = await wikidataEnricher.enrich({ wikidata: "Q64" }, "en");
    const pop = result?.facts?.find((f) => f.label === "Population");
    expect(pop).toBeDefined();
    // Locale-formatted: contains the digits (exact separator depends on runtime locale)
    expect(pop?.value).toMatch(/3.?645.?000/);
  });

  it("batch-resolves item properties in a single API call", async () => {
    const entity = makeEntity({
      claims: {
        P84: [
          {
            rank: "normal",
            mainsnak: {
              snaktype: "value",
              datavalue: { type: "wikibase-entityid", value: { id: "Q123" } },
            },
          },
        ],
        P112: [
          {
            rank: "normal",
            mainsnak: {
              snaktype: "value",
              datavalue: { type: "wikibase-entityid", value: { id: "Q456" } },
            },
          },
        ],
      },
    });
    // First call: entity fetch
    mockFetch.mockResolvedValueOnce(mockOk(makeWdResponse("Q64", entity)));
    // Second call: label resolution
    mockFetch.mockResolvedValueOnce(
      mockOk({
        entities: {
          Q123: { labels: { en: { value: "Norman Foster" } } },
          Q456: { labels: { en: { value: "Frederick II" } } },
        },
      }),
    );

    const { wikidataEnricher } = await loadModule();
    const result = await wikidataEnricher.enrich({ wikidata: "Q64" }, "en");

    // Verify second fetch call has both IDs
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const secondCallUrl = mockFetch.mock.calls[1][0] as string;
    expect(secondCallUrl).toContain("Q123");
    expect(secondCallUrl).toContain("Q456");

    const architect = result?.facts?.find((f) => f.label === "Architect");
    expect(architect?.value).toBe("Norman Foster");
    const founder = result?.facts?.find((f) => f.label === "Founder");
    expect(founder?.value).toBe("Frederick II");
  });

  it("extracts external IDs: P2397 → yelp, P7566 → foursquare", async () => {
    const entity = makeEntity({
      claims: {
        P2397: [
          {
            rank: "normal",
            mainsnak: {
              snaktype: "value",
              datavalue: { type: "string", value: "biz-berlin-kebab" },
            },
          },
        ],
        P7566: [
          {
            rank: "normal",
            mainsnak: {
              snaktype: "value",
              datavalue: { type: "string", value: "4bf58dd8d48988d1" },
            },
          },
        ],
      },
    });
    mockFetch.mockResolvedValueOnce(mockOk(makeWdResponse("Q64", entity)));

    const { wikidataEnricher } = await loadModule();
    const result = await wikidataEnricher.enrich({ wikidata: "Q64" }, "en");
    expect(result?.externalIds).toEqual({
      yelp: "biz-berlin-kebab",
      foursquare: "4bf58dd8d48988d1",
    });
  });

  it("returns null on API error", async () => {
    mockFetch.mockResolvedValueOnce(mockNotOk());

    const { wikidataEnricher } = await loadModule();
    const result = await wikidataEnricher.enrich({ wikidata: "Q64" }, "en");
    expect(result).toBeNull();
  });

  it("returns null when entity is missing in response", async () => {
    mockFetch.mockResolvedValueOnce(mockOk({ entities: {} }));

    const { wikidataEnricher } = await loadModule();
    const result = await wikidataEnricher.enrich({ wikidata: "Q64" }, "en");
    expect(result).toBeNull();
  });

  it("defaults lang to 'en' when not provided", async () => {
    const entity = makeEntity({
      descriptions: { en: { value: "test place" } },
    });
    mockFetch.mockResolvedValueOnce(mockOk(makeWdResponse("Q64", entity)));

    const { wikidataEnricher } = await loadModule();
    const result = await wikidataEnricher.enrich({ wikidata: "Q64" });
    expect(result?.description).toBe("Test place");

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("languages=en");
    expect(url).toContain("sitefilter=enwiki");
  });

  it("prefers 'preferred' rank claims over 'normal'", async () => {
    const entity = makeEntity({
      claims: {
        P571: [
          {
            rank: "normal",
            mainsnak: {
              snaktype: "value",
              datavalue: {
                type: "time",
                value: { time: "+1800-01-01T00:00:00Z", precision: 9 },
              },
            },
          },
          {
            rank: "preferred",
            mainsnak: {
              snaktype: "value",
              datavalue: {
                type: "time",
                value: { time: "+1870-01-01T00:00:00Z", precision: 9 },
              },
            },
          },
        ],
      },
    });
    mockFetch.mockResolvedValueOnce(mockOk(makeWdResponse("Q64", entity)));

    const { wikidataEnricher } = await loadModule();
    const result = await wikidataEnricher.enrich({ wikidata: "Q64" }, "en");
    const founded = result?.facts?.find((f) => f.label === "Founded");
    expect(founded?.value).toBe("1870");
  });

  it("returns null when entity has no extractable data", async () => {
    const entity = makeEntity();
    mockFetch.mockResolvedValueOnce(mockOk(makeWdResponse("Q64", entity)));

    const { wikidataEnricher } = await loadModule();
    const result = await wikidataEnricher.enrich({ wikidata: "Q64" }, "en");
    expect(result).toBeNull();
  });
});
