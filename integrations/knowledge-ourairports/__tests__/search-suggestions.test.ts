import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import type { AirportRecord, AirportSearchMatch } from "@openmapx/ourairports-data";
import { describe, expect, it, vi } from "vitest";
import { createOurAirportsSuggestionProvider } from "../index.js";

const airport: AirportRecord = {
  id: 1,
  ident: "EDDF",
  type: "large_airport",
  iata: "FRA",
  icao: "EDDF",
  scheduledService: true,
  lat: 50.0379,
  lng: 8.5622,
  name: "Frankfurt am Main Airport",
  municipality: "Frankfurt",
  isoCountry: "DE",
};

describe("OurAirports search suggestion adapter", () => {
  it("preserves exact IATA evidence and canonical oa identity", async () => {
    const search = vi.fn().mockResolvedValue([
      {
        record: airport,
        kind: "authoritative_code",
        matchedValue: "FRA",
        namespace: "iata",
      } satisfies AirportSearchMatch,
    ]);
    const provider = createOurAirportsSuggestionProvider(createMockIntegrationContext(), search);

    const result = await provider.searchSuggestions(
      { query: "FRA", lang: "en", limit: 8 },
      { signal: new AbortController().signal, deadlineAt: Number.POSITIVE_INFINITY },
    );

    expect(search).toHaveBeenCalledWith(expect.anything(), "FRA", 8);
    expect(result.suggestions[0]).toMatchObject({
      id: "oa:EDDF",
      ids: { oa: "EDDF", iata: "FRA", icao: "EDDF" },
      label: "Frankfurt am Main Airport",
      searchMatch: { kind: "authoritative_code", value: "FRA", namespace: "iata" },
      importance: 0.9,
    });
    expect(result.attributions[0]).toMatchObject({ sourceId: "ourairports" });
  });
});
