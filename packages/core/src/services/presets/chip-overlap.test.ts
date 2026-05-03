import { describe, expect, it } from "vitest";
import { buildChipOverlapSet } from "./chip-overlap";
import { canonicalTagSet } from "./matcher";

describe("buildChipOverlapSet", () => {
  it("contains a chip-category single-tag mapping (e.g. pharmacy)", () => {
    const set = buildChipOverlapSet();
    const pharmacyKey = canonicalTagSet({ amenity: "pharmacy" });
    expect(set.has(pharmacyKey)).toBe(true);
  });

  it("uses the same canonical form as the matcher", () => {
    const set = buildChipOverlapSet();
    const a = canonicalTagSet({ amenity: "fuel" });
    const b = canonicalTagSet({ amenity: "fuel" });
    expect(a).toBe(b);
    expect(set.has(canonicalTagSet({ amenity: "fuel" }))).toBe(true);
  });

  it("a multi-tag chip category is not collapsed to single-tag entries", () => {
    const set = buildChipOverlapSet();
    // The 'restaurants' chip in CATEGORY_FILTERS maps to multiple OSM tag pairs;
    // a single-tag preset like { amenity: "restaurant" } should NOT be suppressed,
    // because the chip's canonical tag-set differs.
    expect(set.has(canonicalTagSet({ amenity: "restaurant" }))).toBe(false);
  });
});
