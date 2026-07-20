import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wikidataSource } from "./provider.js";

// The Wikidata provider reads a `wbgetentities` claims/descriptions/sitelinks
// payload and maps it to a KnowledgeResult: capitalised description, Wikipedia
// URL + extract, a Commons lead image, external-platform IDs, and typed facts
// (time → year, quantity → unit-labelled number, item → labels resolved by a
// second batch call). These tests pin those transforms. The mock routes by URL
// substring so a single `lookup()` (entity → summary → commons → labels) is
// driven from one responder.

function entityBody() {
  return {
    entities: {
      Q243: {
        descriptions: { en: { value: "iron lattice tower in Paris, France" } },
        sitelinks: { enwiki: { title: "Eiffel Tower" } },
        claims: {
          // Lead image (P18) — a Commons filename.
          P18: [
            {
              rank: "normal",
              mainsnak: {
                snaktype: "value",
                datavalue: { type: "string", value: "Tour Eiffel Wikimedia Commons.jpg" },
              },
            },
          ],
          // Founded (P571) — time.
          P571: [
            {
              rank: "normal",
              mainsnak: {
                snaktype: "value",
                datavalue: {
                  type: "time",
                  value: { time: "+1889-03-31T00:00:00Z", precision: 11 },
                },
              },
            },
          ],
          // Height (P2048) — quantity with a metre unit (Q11573).
          P2048: [
            {
              rank: "normal",
              mainsnak: {
                snaktype: "value",
                datavalue: {
                  type: "quantity",
                  value: { amount: "330", unit: "http://www.wikidata.org/entity/Q11573" },
                },
              },
            },
          ],
          // Architect (P84) — item resolved via the labels batch call.
          P84: [
            {
              rank: "normal",
              mainsnak: {
                snaktype: "value",
                datavalue: { type: "wikibase-entityid", value: { id: "Q92608" } },
              },
            },
          ],
          // External platform ID (P2013 → facebook).
          P2013: [
            {
              rank: "normal",
              mainsnak: {
                snaktype: "value",
                datavalue: { type: "string", value: "TourEiffel" },
              },
            },
          ],
        },
      },
    },
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

describe("Wikidata knowledge provider", () => {
  it("returns null when the wikidata tag is absent", async () => {
    expect(await wikidataSource.lookup({})).toBeNull();
  });

  it("maps description, wikipedia URL/extract, facts, image and external IDs", async () => {
    routes = {
      "props=claims": entityBody(),
      "/page/summary/": { extract: "The Eiffel Tower is a wrought-iron lattice tower." },
      "titles=": { query: { pages: {} } }, // commons metadata: none → FilePath fallback.
      "props=labels": { entities: { Q92608: { labels: { en: { value: "Gustave Eiffel" } } } } },
    };

    const result = await wikidataSource.lookup({ wikidata: "Q243" });

    // Description is capitalised.
    expect(result?.description).toBe("Iron lattice tower in Paris, France");
    expect(result?.wikipediaUrl).toBe("https://en.wikipedia.org/wiki/Eiffel_Tower");
    expect(result?.wikipediaExtract).toBe("The Eiffel Tower is a wrought-iron lattice tower.");
    expect(result?.wikipediaExtractSource).toEqual(["knowledge-wikidata", "knowledge-wikipedia"]);
    expect(result?.externalIds).toEqual({ facebook: "TourEiffel" });
    expect(result?.facts).toEqual([
      { label: "Founded", value: "1889" },
      { label: "Height", value: "330 m" },
      { label: "Architect", value: "Gustave Eiffel" },
    ]);
  });

  it("falls back to a Special:FilePath image when Commons metadata is missing", async () => {
    routes = {
      "props=claims": entityBody(),
      "/page/summary/": { extract: "x" },
      "titles=": { query: { pages: {} } },
      "props=labels": { entities: {} },
    };

    const result = await wikidataSource.lookup({ wikidata: "Q243" });

    expect(result?.photos?.[0]).toEqual({
      url: "https://commons.wikimedia.org/wiki/Special:FilePath/Tour_Eiffel_Wikimedia_Commons.jpg?width=800",
      source: "wikimedia",
      // Metadata fetch failed, so author/license are unknown, but the filename
      // is known — link to the Commons file page instead.
      pageUrl: "https://commons.wikimedia.org/wiki/File:Tour_Eiffel_Wikimedia_Commons.jpg",
    });
  });

  it("requests the entity with the caller's language", async () => {
    routes = {
      "props=claims": entityBody(),
      "/page/summary/": { extract: "x" },
      "titles=": { query: { pages: {} } },
      "props=labels": { entities: {} },
    };

    await wikidataSource.lookup({ wikidata: "Q243" }, "de");

    const entityUrl = mockFetch.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes("props=claims"));
    expect(entityUrl).toContain("ids=Q243");
    expect(entityUrl).toContain("languages=de");
    expect(entityUrl).toContain("sitefilter=dewiki");
  });

  it("returns null when the entity request fails", async () => {
    routes = {}; // entity fetch resolves to 404.

    expect(await wikidataSource.lookup({ wikidata: "Q243" })).toBeNull();
  });

  it("returns null when the entity is not present in the response", async () => {
    routes = { "props=claims": { entities: {} } };

    expect(await wikidataSource.lookup({ wikidata: "Q243" })).toBeNull();
  });
});
