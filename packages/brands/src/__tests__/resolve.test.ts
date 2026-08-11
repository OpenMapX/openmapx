import { describe, expect, it } from "vitest";
import type { BrandIndex } from "../loader";
import { resolveBrandByTags } from "../resolve";
import type { BrandEntry } from "../types";

function entry(qid: string, name: string): BrandEntry {
  return {
    qid,
    name,
    kind: ["brand"],
    matchNames: [name.toLowerCase()],
    countries: [],
    tagSets: [],
    itemCount: 1,
  };
}

const index: BrandIndex = (() => {
  const entries = [entry("Q37158", "Starbucks"), entry("Q42717947", "Ionity")];
  return { entries, byQid: new Map(entries.map((e) => [e.qid, e])), source: "test" };
})();

describe("resolveBrandByTags", () => {
  it("resolves a brand from its brand QID", () => {
    expect(resolveBrandByTags(index, { "brand:wikidata": "Q37158" })?.name).toBe("Starbucks");
  });

  it("resolves from a network QID when no brand QID is present", () => {
    expect(resolveBrandByTags(index, { "network:wikidata": "Q42717947" })?.name).toBe("Ionity");
  });

  it("prefers the brand QID over the operator QID", () => {
    expect(
      resolveBrandByTags(index, {
        "brand:wikidata": "Q37158",
        "operator:wikidata": "Q42717947",
      })?.qid,
    ).toBe("Q37158");
  });

  it("returns undefined for a QID the catalog does not hold", () => {
    expect(resolveBrandByTags(index, { "brand:wikidata": "Q00000000" })).toBeUndefined();
  });

  it("returns undefined for tags with no QID and for absent tags", () => {
    expect(resolveBrandByTags(index, { amenity: "cafe" })).toBeUndefined();
    expect(resolveBrandByTags(index, undefined)).toBeUndefined();
  });

  it("never matches on a brand name alone", () => {
    expect(resolveBrandByTags(index, { brand: "Starbucks" })).toBeUndefined();
  });

  it("prefers the network QID over the operator QID when both are present", () => {
    // BRAND_QID_KEYS orders network:wikidata before operator:wikidata; that
    // order is load-bearing (reversing it silently reassigns records to a
    // different identity — see @openmapx/core's BRAND_QID_KEYS).
    expect(
      resolveBrandByTags(index, {
        "network:wikidata": "Q42717947",
        "operator:wikidata": "Q37158",
      })?.qid,
    ).toBe("Q42717947");
  });

  it("prefers the brand QID over both network and operator QIDs when all three are present", () => {
    const third = entry("Q999", "Third");
    const wideIndex: BrandIndex = {
      entries: [...index.entries, third],
      byQid: new Map([...index.byQid, [third.qid, third]]),
      source: "test",
    };
    expect(
      resolveBrandByTags(wideIndex, {
        "brand:wikidata": "Q37158",
        "network:wikidata": "Q42717947",
        "operator:wikidata": "Q999",
      })?.qid,
    ).toBe("Q37158");
  });
});
