import { describe, expect, it } from "vitest";
import type { BrandIndex } from "../loader";
import { searchBrands } from "../matcher";
import type { BrandEntry } from "../types";

function entry(over: Partial<BrandEntry> & Pick<BrandEntry, "qid" | "name">): BrandEntry {
  return {
    kind: ["brand"],
    matchNames: [over.name.toLowerCase()],
    countries: [],
    tagSets: [],
    itemCount: 1,
    ...over,
  };
}

function index(entries: BrandEntry[]): BrandIndex {
  return {
    entries,
    byQid: new Map(entries.map((e) => [e.qid, e])),
    source: "test",
  };
}

describe("searchBrands", () => {
  it.each(["kentucky fried chicken", "kentucky", "fried"])(
    "returns the winning full alias for %s",
    (q) => {
      const result = searchBrands(
        index([
          entry({ qid: "Q524757", name: "KFC", matchNames: ["kentucky fried chicken", "kfc"] }),
        ]),
        { q, limit: 10 },
      );
      expect(result[0]).toMatchObject({
        qid: "Q524757",
        name: "KFC",
        matchedOn: "alias",
        matchedValue: "kentucky fried chicken",
      });
    },
  );
  it("ranks an exact name match above a prefix match", () => {
    const result = searchBrands(
      index([entry({ qid: "Q1", name: "Star" }), entry({ qid: "Q2", name: "Starbucks" })]),
      { q: "star", limit: 10 },
    );
    expect(result.map((r) => r.qid)).toEqual(["Q1", "Q2"]);
  });

  it("ranks a prefix match above a later-word match", () => {
    const result = searchBrands(
      index([entry({ qid: "Q1", name: "Super Star" }), entry({ qid: "Q2", name: "Starbucks" })]),
      { q: "star", limit: 10 },
    );
    expect(result.map((r) => r.qid)).toEqual(["Q2", "Q1"]);
  });

  it("does not match text in the middle of a word", () => {
    const result = searchBrands(
      index([entry({ qid: "Q1", name: "Palmers Brewery" }), entry({ qid: "Q2", name: "REWE" })]),
      { q: "rewe", limit: 10 },
    );
    expect(result.map((r) => r.qid)).toEqual(["Q2"]);
  });

  it("keeps only entries with the requested role", () => {
    const result = searchBrands(
      index([
        entry({ qid: "Q1", name: "Brandenburg Police", kind: ["operator"] }),
        entry({ qid: "Q2", name: "Brandenburger Hof", kind: ["brand", "operator"] }),
      ]),
      { q: "brandenb", limit: 10, kind: "brand" },
    );
    expect(result.map((r) => r.qid)).toEqual(["Q2"]);
  });

  it("reports where the chain operates relative to the requested country", () => {
    const result = searchBrands(
      index([
        entry({ qid: "Q1", name: "Star One", countries: ["de"] }),
        entry({ qid: "Q2", name: "Star Two", countries: ["001"] }),
        entry({ qid: "Q3", name: "Star Three", countries: [] }),
        entry({ qid: "Q4", name: "Star Four", countries: ["us"] }),
      ]),
      { q: "star", country: "de", limit: 10 },
    );
    expect(Object.fromEntries(result.map((r) => [r.qid, r.presence]))).toEqual({
      Q1: "here",
      Q2: "global",
      Q3: "unknown",
      Q4: "elsewhere",
    });
  });

  it("matches case- and diacritic-insensitively", () => {
    const result = searchBrands(
      index([entry({ qid: "Q1", name: "Café Nero", matchNames: ["cafe nero"] })]),
      { q: "CAFÉ NERO", limit: 10 },
    );
    expect(result.map((r) => r.qid)).toEqual(["Q1"]);
  });

  it("boosts a brand present in the requested country above one that is not", () => {
    const result = searchBrands(
      index([
        entry({ qid: "Q1", name: "Star", countries: ["us"], itemCount: 50 }),
        entry({ qid: "Q2", name: "Star", countries: ["de"], itemCount: 2 }),
      ]),
      { q: "star", country: "de", limit: 10 },
    );
    expect(result[0].qid).toBe("Q2");
  });

  it("breaks ties by itemCount when both entries mismatch the country", () => {
    const result = searchBrands(
      index([
        entry({ qid: "Q1", name: "Star", countries: ["us"], itemCount: 2 }),
        entry({ qid: "Q2", name: "Star", countries: ["gb"], itemCount: 40 }),
      ]),
      { q: "star", country: "fr", limit: 10 },
    );
    expect(result[0].qid).toBe("Q2");
  });

  it("ranks a country-less (global) brand below a country match but above a mismatch", () => {
    const result = searchBrands(
      index([
        entry({ qid: "Q1", name: "Star", countries: ["us"] }),
        entry({ qid: "Q2", name: "Star", countries: [] }),
        entry({ qid: "Q3", name: "Star", countries: ["de"] }),
      ]),
      { q: "star", country: "de", limit: 10 },
    );
    expect(result.map((r) => r.qid)).toEqual(["Q3", "Q2", "Q1"]);
  });

  it("matches on a non-primary matchName and reports matchedOn", () => {
    // Alphabetical order, matching what the generator actually produces.
    const result = searchBrands(
      index([entry({ qid: "Q1", name: "McDonald's", matchNames: ["mcd", "mcdonalds"] })]),
      { q: "mcd", limit: 10 },
    );
    expect(result[0].matchedOn).toBe("alias");
  });

  it("reports matchedOn: name for the display name even when an alias sorts first alphabetically", () => {
    // "star" sorts before "star market" — the alphabetically-first matchName
    // here is an alias, not the canonical display name.
    const result = searchBrands(
      index([entry({ qid: "Q1", name: "Star Market", matchNames: ["star", "star market"] })]),
      { q: "star market", limit: 10 },
    );
    expect(result[0].matchedOn).toBe("name");
  });

  it("reports matchedOn: alias for an alias hit even when it sorts before the display name", () => {
    const result = searchBrands(
      index([entry({ qid: "Q1", name: "Star Market", matchNames: ["star", "star market"] })]),
      { q: "star", limit: 10 },
    );
    expect(result[0].matchedOn).toBe("alias");
  });

  it("returns an empty array for a blank query", () => {
    expect(
      searchBrands(index([entry({ qid: "Q1", name: "Star" })]), { q: "  ", limit: 10 }),
    ).toEqual([]);
  });

  it("respects the limit", () => {
    const entries = Array.from({ length: 30 }, (_, i) =>
      entry({ qid: `Q${i}`, name: `Star ${i}`, matchNames: [`star ${i}`] }),
    );
    expect(searchBrands(index(entries), { q: "star", limit: 5 })).toHaveLength(5);
  });

  it("never lets a country match outrank a stronger text tier from a different country", () => {
    // Q1 is only a later-word match ("super star") but sits in the requested
    // country; Q2 is an exact match but in a different country. Text tier
    // must decide first — country only breaks ties within the same tier.
    const result = searchBrands(
      index([
        entry({ qid: "Q1", name: "Super Star", countries: ["de"] }),
        entry({ qid: "Q2", name: "Star", countries: ["us"] }),
      ]),
      { q: "star", country: "de", limit: 10 },
    );
    expect(result.map((r) => r.qid)).toEqual(["Q2", "Q1"]);
  });

  it("matches the canonical name even when absent from matchNames, and reports matchedOn: name", () => {
    // entry.name is the Wikidata label and is not guaranteed to appear in
    // matchNames; a query hitting only the canonical name must still match.
    const result = searchBrands(
      index([entry({ qid: "Q1", name: "Star Market", matchNames: ["stjernemarked"] })]),
      { q: "star market", limit: 10 },
    );
    expect(result.map((r) => r.qid)).toEqual(["Q1"]);
    expect(result[0].matchedOn).toBe("name");
  });
});
