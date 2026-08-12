import type { MobilityResult } from "@openmapx/mobility-core/result";
import type { TransitStop } from "@openmapx/mobility-core/transit";
import { describe, expect, it, vi } from "vitest";
import { createTransitSuggestionProvider } from "../index.js";

const stop: TransitStop = {
  id: "db:8000207",
  ids: { db: "8000207", eva: "8000207" },
  codes: [{ value: "8000207", namespace: "eva" }],
  name: "Hamburg Hbf",
  lat: 53.5526,
  lng: 10.0067,
  modes: ["rail"],
  provider: "db",
};

const result: MobilityResult<TransitStop[]> = {
  data: [stop],
  attributions: [{ sourceId: "db", name: "Deutsche Bahn" }],
  freshness: { fetchedAt: new Date(0).toISOString(), hasRealtimeData: false, isStale: false },
};

describe("transit search suggestion adapter", () => {
  it("classifies exact public codes without exposing internal ids as evidence", async () => {
    const searchByName = vi.fn().mockResolvedValue(result);
    const provider = createTransitSuggestionProvider({ searchByName });

    const response = await provider.searchSuggestions({
      query: "8000207",
      lang: "de",
      limit: 3,
    });

    expect(response.suggestions[0]).toMatchObject({
      id: "db:8000207",
      label: "Hamburg Hbf",
      searchMatch: { kind: "authoritative_code", value: "8000207", namespace: "eva" },
      transitStop: stop,
    });
    expect(response.suggestions[0].searchMatch.value).not.toContain("db:");
    expect(response.attributions).toEqual(result.attributions);
  });

  it("classifies a normal stop-name match as name evidence", async () => {
    const provider = createTransitSuggestionProvider({
      searchByName: vi.fn().mockResolvedValue(result),
    });
    const response = await provider.searchSuggestions({ query: "Hamburg", lang: "de", limit: 3 });
    expect(response.suggestions[0].searchMatch).toMatchObject({
      kind: "name",
      value: "Hamburg Hbf",
    });
  });
});
