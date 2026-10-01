import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { createNotablePlacesSuggestionProvider } from "../provider.js";

const options = { signal: new AbortController().signal, deadlineAt: Number.POSITIVE_INFINITY };

function readyIndex(rows: unknown[]) {
  return vi
    .fn()
    .mockResolvedValueOnce([{ exists: true }])
    .mockResolvedValueOnce([{ epoch: "epoch-1", status: "ready" }])
    .mockResolvedValueOnce(rows);
}

describe("notable-places suggestion provider", () => {
  it("names the place in the app's language and keeps the name that matched", async () => {
    const execute = readyIndex([
      {
        qid: "Q19675",
        kind: "place",
        lat: 48.861,
        lng: 2.336,
        fame: 0.89,
        matched: "Louvre",
        normalized: "louvre",
        label: "Louvre Museum",
        description: "art museum in Paris, France",
      },
    ]);
    const provider = createNotablePlacesSuggestionProvider(
      createMockIntegrationContext({ db: { execute } }),
    );

    const result = await provider.searchSuggestions(
      { query: "Louvre", lang: "en", limit: 8, proximity: [13.4, 52.52] },
      options,
    );

    expect(execute.mock.calls[2]?.[1]).toEqual(["louvre", 8, "en", 13.4, 52.52]);
    expect(result.suggestions).toEqual([
      expect.objectContaining({
        id: "wikidata:Q19675",
        ids: { wikidata: "Q19675" },
        label: "Louvre Museum",
        sublabel: "art museum in Paris, France",
        coordinates: [2.336, 48.861],
        type: "poi",
        searchMatch: { kind: "name", value: "Louvre", normalized: "louvre" },
        fame: 0.89,
        provider: "search-notable-places",
      }),
    ]);
    expect(result.attributions).toEqual([
      expect.objectContaining({ sourceId: "wikidata", spdxLicense: "CC0-1.0" }),
    ]);
  });

  it("shows the name that matched when the app's label leaves out what was typed", async () => {
    const execute = readyIndex([
      {
        qid: "Q48435",
        kind: "place",
        lat: 41.4,
        lng: 2.17,
        fame: 0.8,
        matched: "Sagrada Família",
        normalized: "sagrada familia",
        label: "Basilica and Expiatory Church of the Holy Family",
        otherLabels: ["Basilica and Expiatory Church of the Holy Family"],
        description: "basilica in Barcelona",
      },
    ]);
    const provider = createNotablePlacesSuggestionProvider(
      createMockIntegrationContext({ db: { execute } }),
    );

    const result = await provider.searchSuggestions(
      { query: "sagrada familia", lang: "en", limit: 8 },
      options,
    );

    expect(result.suggestions[0]?.label).toBe("Sagrada Família");
  });

  it("prefers a full name in another language to a bare alias that reads as somewhere else", async () => {
    const execute = readyIndex([
      {
        qid: "Q131402",
        kind: "place",
        lat: 48.354,
        lng: 11.786,
        fame: 0.7,
        iata: "MUC",
        matched: "München",
        normalized: "munchen",
        label: "Munich Airport",
        otherLabels: ["Flughafen München", "Munich Airport"],
        description: "international airport serving Munich",
      },
    ]);
    const provider = createNotablePlacesSuggestionProvider(
      createMockIntegrationContext({ db: { execute } }),
    );

    const result = await provider.searchSuggestions(
      { query: "münchen", lang: "en", limit: 8 },
      options,
    );

    expect(result.suggestions[0]).toMatchObject({
      label: "Flughafen München",
      searchMatch: { value: "München" },
    });
  });

  it("offers a city found by its name in another language as a city", async () => {
    const execute = readyIndex([
      {
        qid: "Q220",
        kind: "settlement",
        lat: 41.893,
        lng: 12.483,
        fame: 1,
        matched: "Rom",
        normalized: "rom",
        label: "Rome",
        description: "capital and largest city of Italy",
      },
      {
        qid: "Q36947",
        kind: "settlement",
        lat: -12.97,
        lng: -38.51,
        fame: 0.9,
        matched: "Roma Negra",
        normalized: "roma negra",
        label: "Salvador",
        description: "capital of Bahia",
      },
    ]);
    const provider = createNotablePlacesSuggestionProvider(
      createMockIntegrationContext({ db: { execute } }),
    );

    const result = await provider.searchSuggestions(
      { query: "rom", lang: "en", limit: 8 },
      options,
    );

    expect(result.suggestions[0]).toMatchObject({
      label: "Rome",
      type: "region",
      rawCategory: "place/city",
      searchMatch: { value: "Rom", normalized: "rom" },
      fame: 1,
    });
    // A city keeps its own name; a nickname is only what matched.
    expect(result.suggestions[1]?.label).toBe("Salvador");
  });

  it("offers famous places spelled close to text that names nothing exactly", async () => {
    const execute = readyIndex([]).mockResolvedValueOnce([
      {
        qid: "Q48435",
        kind: "place",
        lat: 41.4,
        lng: 2.17,
        fame: 0.8,
        matched: "Sagrada Família",
        normalized: "sagrada familia",
        label: "Basilica and Expiatory Church of the Holy Family",
        otherLabels: ["Basilica and Expiatory Church of the Holy Family", "Sagrada Família"],
        description: "basilica in Barcelona",
      },
    ]);
    const provider = createNotablePlacesSuggestionProvider(
      createMockIntegrationContext({ db: { execute } }),
    );

    const result = await provider.searchSuggestions(
      { query: "sagrada famila", lang: "en", limit: 8 },
      options,
    );

    // Two slips are allowed from 8 letters on.
    expect(execute.mock.calls[3]?.[1]).toEqual(["sagrada famila", 3, "en", 2]);
    expect(result.suggestions).toEqual([
      expect.objectContaining({
        label: "Sagrada Família",
        searchMatch: {
          kind: "near_name",
          value: "Sagrada Família",
          normalized: "sagrada familia",
        },
      }),
    ]);
  });

  it("looks for no near spelling when the text names a place exactly", async () => {
    const execute = readyIndex([
      {
        qid: "Q243",
        kind: "place",
        lat: 48.858,
        lng: 2.294,
        fame: 0.95,
        matched: "Eiffel Tower",
        normalized: "eiffel tower",
        label: "Eiffel Tower",
        otherLabels: ["Eiffelturm", "Eiffel Tower"],
        description: "tower in Paris",
      },
    ]);
    const provider = createNotablePlacesSuggestionProvider(
      createMockIntegrationContext({ db: { execute } }),
    );

    await provider.searchSuggestions({ query: "eiffel tower", lang: "en", limit: 8 }, options);

    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("answers nothing until a snapshot is published, without reading the index", async () => {
    const execute = vi.fn().mockResolvedValueOnce([{ exists: false }]);
    const provider = createNotablePlacesSuggestionProvider(
      createMockIntegrationContext({ db: { execute } }),
    );

    const result = await provider.searchSuggestions(
      { query: "louvre", lang: "en", limit: 8 },
      options,
    );

    expect(result.suggestions).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("leaves queries too short to say anything about fame alone", async () => {
    const execute = vi.fn();
    const provider = createNotablePlacesSuggestionProvider(
      createMockIntegrationContext({ db: { execute } }),
    );

    const result = await provider.searchSuggestions({ query: "lo", lang: "en", limit: 8 }, options);

    expect(result.suggestions).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});
