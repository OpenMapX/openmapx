import { resolveBrand } from "@openmapx/brands";
import { describe, expect, it } from "vitest";

describe("brand crossover resolution", () => {
  it("resolves a charging network from its network QID", () => {
    // Ionity — verified against the artifact (packages/brands/src/data/brands-index.json).
    const entry = resolveBrand({ "network:wikidata": "Q42717773" });
    expect(entry?.name.toLowerCase()).toContain("ionity");
  });

  it("prefers the brand QID over the operator QID", () => {
    const entry = resolveBrand({
      "brand:wikidata": "Q37158",
      "operator:wikidata": "Q42717773",
    });
    expect(entry?.qid).toBe("Q37158");
  });

  it("returns undefined for tags with no catalogued identity", () => {
    expect(resolveBrand({ amenity: "fuel" })).toBeUndefined();
    expect(resolveBrand(undefined)).toBeUndefined();
  });
});
