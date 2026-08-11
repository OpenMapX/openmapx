import { describe, expect, it } from "vitest";
import { resolveBrandPredicates } from "../brand-resolution";

describe("resolveBrandPredicates", () => {
  it("replaces a name predicate naming a catalogued chain with its QID", () => {
    // "Lidl" has one exact-name catalog entry (Q151954); "Aldi" has none — the
    // catalog splits it into "Aldi Nord"/"Aldi Süd" (matchedOn "alias"), so it
    // doesn't exercise the exact-name path this test targets.
    const filter = {
      selectors: [{ tags: [{ key: "shop", op: "=" as const, value: "supermarket" }] }],
      require: [{ key: "brand", op: "=" as const, value: "Lidl" }],
    };
    const resolved = resolveBrandPredicates(filter, "de");
    expect(resolved.require?.[0].key).toBe("brand:wikidata");
    expect(resolved.require?.[0].value).toMatch(/^Q\d+$/);
  });

  it("leaves an unrecognised brand name untouched", () => {
    const filter = {
      selectors: [{ tags: [{ key: "shop", op: "=" as const, value: "supermarket" }] }],
      require: [{ key: "brand", op: "=" as const, value: "Zzyzx Corner Store" }],
    };
    expect(resolveBrandPredicates(filter, "de")).toEqual(filter);
  });

  it("leaves filters with no brand predicate untouched", () => {
    const filter = { selectors: [{ tags: [{ key: "amenity", op: "=" as const, value: "cafe" }] }] };
    expect(resolveBrandPredicates(filter, "de")).toEqual(filter);
  });

  it("only substitutes on an exact catalog match, never a partial one", () => {
    // "Li" is a genuine prefix of the cataloged "Lidl" — proves the resolver
    // does not rewrite a partial/prefix hit into the wrong (or a guessed) chain.
    const filter = {
      selectors: [{ tags: [{ key: "shop", op: "=" as const, value: "supermarket" }] }],
      require: [{ key: "brand", op: "=" as const, value: "Li" }],
    };
    expect(resolveBrandPredicates(filter, "de")).toEqual(filter);
  });
});
