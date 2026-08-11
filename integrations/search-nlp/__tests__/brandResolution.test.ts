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
    // Referential identity, not just deep equality: the early `return filter`
    // for a require-less filter must hand back the same object, not a copy.
    expect(resolveBrandPredicates(filter, "de")).toBe(filter);
  });

  it("leaves an alias-only match untouched", () => {
    // "Aldi" is an exact alias of both "Aldi Nord" and "Aldi Süd" — the catalog
    // has no brand literally named "Aldi", so suggestBrands ranks the top hit
    // matchedOn "alias" (its winning candidate is the alias "Aldi", not the
    // entry's own display name "Aldi Nord"/"Aldi Süd"). Guard 2 (exact string
    // equality against `top.name`) already rejects this on its own, since
    // "Aldi" !== "Aldi Nord". Given @openmapx/brands' matcher scoring — a
    // name-tier hit always outscores an alias-tier hit on the same entry when
    // both match the query equally well (see matcher.ts's 0.9x alias
    // penalty) — `matchedOn === "name"` is implied whenever guard 2 passes,
    // so this fixture cannot isolate guard 1's *alias-rejection* role from
    // guard 2. That role is genuinely redundant here. But guard 1 is not
    // redundant overall: on a zero-hit query, `top` is `undefined`, and
    // guard 1 (`top?.matchedOn !== "name"`) is what returns early before
    // guard 2 would dereference `top.name` and throw. Removing guard 1
    // believing it only duplicates guard 2 would reintroduce that crash —
    // see the "leaves an unrecognised brand name untouched" case above,
    // which is what actually exercises the zero-hit path.
    const filter = {
      selectors: [{ tags: [{ key: "shop", op: "=" as const, value: "supermarket" }] }],
      require: [{ key: "brand", op: "=" as const, value: "Aldi" }],
    };
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
