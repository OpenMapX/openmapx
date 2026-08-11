import { describe, expect, it } from "vitest";
import { BRAND_QID_KEYS, brandToFilter, commonsLogoUrl } from "../brandFilter";
import { validateOverpassFilter } from "../overpassFilter";

describe("brandToFilter", () => {
  it("emits one selector for a brand-only identity", () => {
    expect(brandToFilter({ qid: "Q41171", kind: ["brand"] })).toEqual({
      selectors: [{ tags: [{ key: "brand:wikidata", op: "=", value: "Q41171" }] }],
    });
  });

  it("emits one selector per kind, in a stable order", () => {
    const filter = brandToFilter({ qid: "Q1", kind: ["operator", "brand", "network"] });
    expect(filter.selectors.map((s) => s.tags[0].key)).toEqual([
      "brand:wikidata",
      "network:wikidata",
      "operator:wikidata",
    ]);
    for (const selector of filter.selectors) {
      expect(selector.tags[0].value).toBe("Q1");
    }
  });

  it("produces a filter that passes validation", () => {
    const result = validateOverpassFilter(
      brandToFilter({ qid: "Q1", kind: ["brand", "operator"] }),
    );
    expect(result.ok).toBe(true);
  });

  it("falls back to the brand key when kind is empty", () => {
    expect(brandToFilter({ qid: "Q1", kind: [] }).selectors).toEqual([
      { tags: [{ key: "brand:wikidata", op: "=", value: "Q1" }] },
    ]);
  });
});

describe("BRAND_QID_KEYS", () => {
  it("lists the QID keys in precedence order", () => {
    expect(BRAND_QID_KEYS).toEqual(["brand:wikidata", "network:wikidata", "operator:wikidata"]);
  });
});

describe("commonsLogoUrl", () => {
  it("builds a Special:FilePath URL at the requested width", () => {
    expect(commonsLogoUrl("Starbucks Corporation Logo.svg", 64)).toBe(
      "https://commons.wikimedia.org/wiki/Special:FilePath/Starbucks%20Corporation%20Logo.svg?width=64",
    );
  });

  it("encodes characters that would otherwise break the path", () => {
    expect(commonsLogoUrl("A&W logo.svg", 64)).toContain("A%26W");
  });

  it("defaults to a 64px render", () => {
    expect(commonsLogoUrl("x.svg")).toContain("width=64");
  });
});
