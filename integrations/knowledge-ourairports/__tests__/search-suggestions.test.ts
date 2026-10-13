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
    expect(result.suggestions[0]?.contributors).toEqual(result.attributions);
    expect(result.attributions[0]).toMatchObject({ sourceId: "ourairports" });
  });
});

it("snapshots the supplier before asynchronous dataset search", async () => {
  const pending = Promise.withResolvers<AirportSearchMatch[]>();
  const credit = {
    sourceId: "ourairports",
    name: "Original",
    publisher: { name: "Original publisher" },
  };
  const ctx = createMockIntegrationContext();
  ctx.attributionIndex = {
    getById: () => credit,
    list: () => [credit],
  } as typeof ctx.attributionIndex;
  const resultPromise = createOurAirportsSuggestionProvider(
    ctx,
    () => pending.promise,
  ).searchSuggestions(
    { query: "FRA", lang: "en", limit: 8 },
    { signal: new AbortController().signal, deadlineAt: Number.POSITIVE_INFINITY },
  );
  credit.name = "Changed";
  credit.publisher.name = "Changed publisher";
  pending.resolve([{ record: airport, kind: "name", matchedValue: "Frankfurt" }]);
  const result = await resultPromise;
  expect(result.suggestions[0].contributors?.[0]).toMatchObject({
    name: "Original",
    publisher: { name: "Original publisher" },
  });
  expect(result.attributions).toEqual(result.suggestions[0].contributors);
});
