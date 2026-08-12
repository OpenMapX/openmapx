import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { createOsmAliasSuggestionProvider } from "../provider.js";

describe("OSM alias suggestion provider", () => {
  it("uses normalized parameterized lookup and maps exact code evidence", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ epoch: "epoch-1", status: "ready" }])
      .mockResolvedValueOnce([
        {
          osm_type: "node",
          osm_id: "42",
          name: "Frankfurt Airport",
          lat: 50.03,
          lng: 8.57,
          category: "aeroway/aerodrome",
          tags: { wikidata: "Q46033" },
          importance: 0.9,
          display_value: "FRA",
          normalized_term: "fra",
          kind: "authoritative_code",
          namespace: "iata",
        },
      ]);
    const provider = createOsmAliasSuggestionProvider(
      createMockIntegrationContext({ db: { execute } }),
    );

    const result = await provider.searchSuggestions({ query: "FRA", lang: "en", limit: 8 });

    expect(execute.mock.calls[1]?.[1]).toEqual(["fra", true, 8, null, null, true]);
    expect(result.suggestions[0]).toMatchObject({
      id: "osm:node/42",
      ids: { osm: "node/42", wikidata: "Q46033" },
      searchMatch: { kind: "authoritative_code", value: "FRA", namespace: "iata" },
    });
    expect(result.attributions).toEqual([
      expect.objectContaining({ sourceId: "openstreetmap", spdxLicense: "ODbL-1.0" }),
    ]);
  });

  it("passes lowercase acronym intent and proximity to the SQL gate", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ epoch: "epoch-2", status: "ready" }])
      .mockResolvedValueOnce([]);
    const provider = createOsmAliasSuggestionProvider(
      createMockIntegrationContext({ db: { execute } }),
    );

    await provider.searchSuggestions({
      query: "uncc",
      lang: "en",
      limit: 4,
      proximity: [-80.73, 35.3],
    });

    expect(execute.mock.calls[1]?.[1]).toEqual(["uncc", true, 4, -80.73, 35.3, false]);
    expect(String(execute.mock.calls[1]?.[0])).toContain("ST_DWithin");
  });
});
