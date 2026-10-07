import { describe, expect, it } from "vitest";
import type { AutocompleteResult } from "../../types/geocoding";
import { queryNamesLocation, textMatchScore } from "../searchSuggestion";
import { enterAction, rankAutocompleteRows } from "../suggestionRanking";
import captured from "./fixtures/business-location-intent.json";

// Adapted hosted autocomplete, captured 2026-10-07. Not raw MapTiler data.
const places = captured as AutocompleteResult[];
const [rijswijk, berlin] = places;
const context = {
  query: "MediaMarkt Alexa",
  proximity: [13.416, 52.5194] as [number, number],
  zoom: 15,
};

describe("business location evidence", () => {
  it("retains a partial street match without treating it as an exact destination", () => {
    expect(textMatchScore(rijswijk, context.query)).toBeLessThan(0.75);
    expect(textMatchScore(rijswijk, context.query)).toBeGreaterThan(
      textMatchScore(berlin, context.query),
    );
    expect(queryNamesLocation(rijswijk, context.query)).toBe(false);
  });

  it("ranks Berlin above the weak remote prefix despite Rijswijk-first retrieval", () => {
    expect(places[0].id).toBe("maptiler:poi.15539884");
    const rows = rankAutocompleteRows({ places }, context);
    expect(rows).toHaveLength(places.length);
    expect(rows[0].id).toBe("maptiler:poi.15422100");
    expect(rows[1].id).toBe("maptiler:poi.15539884");
    expect(enterAction(rows, context)).toEqual({ kind: "search", weak: true });
  });

  it.each([
    "MediaMarkt Rijswijk",
    "MediaMarkt Alexander",
    "MediaMarkt Pr Willem Alexander Prom 69-83",
    "MediaMarkt 2284 DJ Rijswijk",
  ])("retains complete remote city/address intent: %s", (query) => {
    const remote = { ...context, query };
    expect(queryNamesLocation(rijswijk, query)).toBe(true);
    expect(rankAutocompleteRows({ places }, remote)[0].id).toBe(rijswijk.id);
    expect(enterAction(rankAutocompleteRows({ places }, remote), remote)).toMatchObject({
      kind: "open",
      row: { id: rijswijk.id },
    });
  });

  it.each(["MediaMarkt Rijs", "MediaMarkt Willem Alexa", "MediaMarkt 69-8"])(
    "does not establish location intent from incomplete or repeated name words: %s",
    (query) => {
      expect(queryNamesLocation(rijswijk, query)).toBe(false);
      expect(textMatchScore(rijswijk, query)).toBeLessThan(0.75);
    },
  );

  it("does not use the repeated display name as address corroboration", () => {
    expect(queryNamesLocation(rijswijk, "MediaMarkt MediaMarkt")).toBe(false);
  });

  it("preserves normalized numbered street evidence", () => {
    const row: AutocompleteResult = {
      ...rijswijk,
      sublabel: "MediaMarkt, Friedrichstraße 100, Berlin",
    };
    expect(queryNamesLocation(row, "MediaMarkt Friedrichstr. 100")).toBe(true);
    expect(textMatchScore(row, "MediaMarkt Friedrichstr. 100")).toBe(1);
  });

  it("keeps primary-name autocomplete confident without declaring an address", () => {
    const row: AutocompleteResult = { ...rijswijk, label: "MediaMarkt Alexanderplatz" };
    expect(textMatchScore(row, context.query)).toBe(0.8);
    expect(queryNamesLocation(row, context.query)).toBe(false);
  });

  it.each(["explicit_alias", "authoritative_code"] as const)(
    "preserves exact remote %s evidence",
    (kind) => {
      const row: AutocompleteResult = {
        ...rijswijk,
        searchMatch: { kind, value: "MMA", normalized: "mma" },
      };
      const remote = { ...context, query: "MMA" };
      expect(
        enterAction(rankAutocompleteRows({ places: [berlin, row] }, remote), remote),
      ).toMatchObject({ kind: "open", row: { id: rijswijk.id } });
    },
  );

  it("preserves exact station abbreviation and same-name proximity ranking", () => {
    const station: AutocompleteResult = {
      ...rijswijk,
      label: "Neuss Hbf",
      sublabel: "Neuss Hbf, Neuss",
      rawCategory: "railway/station",
    };
    expect(textMatchScore(station, "Neuss Hauptbahnhof")).toBe(1);
    expect(rankAutocompleteRows({ places }, { ...context, query: "MediaMarkt" })[0].id).toBe(
      berlin.id,
    );
  });
});
