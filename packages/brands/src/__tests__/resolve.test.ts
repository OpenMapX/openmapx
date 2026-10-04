import { describe, expect, it } from "vitest";
import { resolveBrandByName } from "../index";
import type { BrandIndex } from "../loader";
import { brandNameIndex, matchBrandName, resolveBrandByTags } from "../resolve";
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

describe("matchBrandName", () => {
  function fuelEntry(qid: string, name: string, countries: string[], tagSets = ["amenity=fuel"]) {
    return { ...entry(qid, name), matchNames: [name.toLowerCase()], countries, tagSets };
  }

  const fuel: BrandIndex = (() => {
    const entries = [
      fuelEntry("Q1", "Aral", ["de", "lu"]),
      fuelEntry("Q2", "Shell", ["001", "eg"]),
      fuelEntry("Q3", "Shell", ["fi", "no"]),
      fuelEntry("Q4", "Total", ["fr"]),
      fuelEntry("Q5", "Total", ["be"]),
      fuelEntry("Q6", "Rewe", ["de"], ["shop=supermarket"]),
      fuelEntry("Q7", "Agip", []),
      fuelEntry("Q8", "Agip", ["it"]),
      { ...fuelEntry("Q9", "Citroën Énergie", ["fr"]), matchNames: ["citroen energie"] },
    ];
    return { entries, byQid: new Map(entries.map((e) => [e.qid, e])), source: "test" };
  })();

  it("matches the exact name within the tag set", () => {
    expect(matchBrandName(fuel, "Aral", { tagSet: "amenity=fuel" })?.qid).toBe("Q1");
  });

  it("normalises case, diacritics and whitespace", () => {
    expect(matchBrandName(fuel, "  ARAL ", { tagSet: "amenity=fuel" })?.qid).toBe("Q1");
    expect(matchBrandName(fuel, "Citroen  ENERGIE", { tagSet: "amenity=fuel" })?.qid).toBe("Q9");
    expect(matchBrandName(fuel, "citroën énergie", { tagSet: "amenity=fuel" })?.qid).toBe("Q9");
  });

  it("never matches a prefix or a word inside the name", () => {
    expect(matchBrandName(fuel, "Ara", { tagSet: "amenity=fuel" })).toBeUndefined();
    expect(matchBrandName(fuel, "Aral Tankstelle", { tagSet: "amenity=fuel" })).toBeUndefined();
  });

  it("ignores entries outside the tag set", () => {
    expect(matchBrandName(fuel, "Rewe", { tagSet: "amenity=fuel" })).toBeUndefined();
    expect(matchBrandName(fuel, "Aral", { tagSet: "shop=supermarket" })).toBeUndefined();
  });

  it("resolves an ambiguous name by the country, counting worldwide entries", () => {
    expect(matchBrandName(fuel, "Shell", { tagSet: "amenity=fuel", country: "DE" })?.qid).toBe(
      "Q2",
    );
    expect(matchBrandName(fuel, "Total", { tagSet: "amenity=fuel", country: "fr" })?.qid).toBe(
      "Q4",
    );
  });

  it("counts an entry without countries as present everywhere", () => {
    expect(matchBrandName(fuel, "Agip", { tagSet: "amenity=fuel", country: "de" })?.qid).toBe("Q7");
  });

  it("returns undefined while a name stays ambiguous", () => {
    expect(matchBrandName(fuel, "Shell", { tagSet: "amenity=fuel" })).toBeUndefined();
    expect(
      matchBrandName(fuel, "Shell", { tagSet: "amenity=fuel", country: "fi" }),
    ).toBeUndefined();
    expect(
      matchBrandName(fuel, "Total", { tagSet: "amenity=fuel", country: "de" }),
    ).toBeUndefined();
    expect(matchBrandName(fuel, "Agip", { tagSet: "amenity=fuel", country: "it" })).toBeUndefined();
  });

  it("returns undefined for an empty name", () => {
    expect(matchBrandName(fuel, "  ", { tagSet: "amenity=fuel" })).toBeUndefined();
  });

  it("rejects a single match catalogued only in another country", () => {
    expect(matchBrandName(fuel, "Aral", { tagSet: "amenity=fuel", country: "fr" })).toBeUndefined();
    expect(matchBrandName(fuel, "Aral", { tagSet: "amenity=fuel", country: "de" })?.qid).toBe("Q1");
  });

  it("lets a single worldwide or unscoped match pass any country", () => {
    const index: BrandIndex = (() => {
      const entries = [fuelEntry("Q10", "Globo", ["001"]), fuelEntry("Q11", "Nowhere", [])];
      return { entries, byQid: new Map(entries.map((e) => [e.qid, e])), source: "test" };
    })();
    expect(matchBrandName(index, "Globo", { tagSet: "amenity=fuel", country: "fr" })?.qid).toBe(
      "Q10",
    );
    expect(matchBrandName(index, "Nowhere", { tagSet: "amenity=fuel", country: "fr" })?.qid).toBe(
      "Q11",
    );
  });

  it("builds the name lookup once per catalog and tag set", () => {
    const first = brandNameIndex(fuel, "amenity=fuel");
    matchBrandName(fuel, "Aral", { tagSet: "amenity=fuel" });
    matchBrandName(fuel, "Shell", { tagSet: "amenity=fuel", country: "de" });
    expect(brandNameIndex(fuel, "amenity=fuel")).toBe(first);
    expect(brandNameIndex(fuel, "shop=supermarket")).not.toBe(first);
    expect(first.get("aral")?.map((e) => e.qid)).toEqual(["Q1"]);
  });
});

describe("resolveBrandByName", () => {
  it("resolves a fuel brand from the committed catalog", () => {
    const aral = resolveBrandByName("Aral", { tagSet: "amenity=fuel", country: "DE" });
    expect(aral?.qid).toBe("Q565734");
    expect(aral?.logoFile).toBeTruthy();
  });

  it("resolves a name shared across countries only where it is unambiguous", () => {
    expect(resolveBrandByName("Shell", { tagSet: "amenity=fuel", country: "de" })?.qid).toBe(
      "Q110716465",
    );
    expect(resolveBrandByName("Shell", { tagSet: "amenity=fuel" })).toBeUndefined();
  });
});
