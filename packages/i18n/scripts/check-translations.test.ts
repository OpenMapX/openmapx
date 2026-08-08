import { describe, expect, it } from "vitest";
import de from "../locales/de.json";
import en from "../locales/en.json";
import { extractICUVariables, flattenKeys } from "./check-translations.ts";

// Pure helpers from the translation health checker. flattenKeys + extractICUVariables
// are the primitives every other check composes from (key parity, ICU placeholder
// consistency). Testing them protects the protector: this gate is the only thing
// keeping locale drift (missing keys, mismatched ICU vars) out of shipped builds.

describe("flattenKeys (nested object → dot paths)", () => {
  it("flattens a nested object into dot-separated keys", () => {
    const flat = flattenKeys({
      a: "1",
      b: { c: "2", d: { e: "3" } },
    });
    expect(Object.fromEntries(flat)).toEqual({
      a: "1",
      "b.c": "2",
      "b.d.e": "3",
    });
  });

  it("applies a prefix to every key", () => {
    const flat = flattenKeys({ x: "v" }, "root");
    expect([...flat.keys()]).toEqual(["root.x"]);
  });

  it("treats arrays as leaf values (not recursed into)", () => {
    const flat = flattenKeys({ items: ["a", "b"] });
    expect([...flat.keys()]).toEqual(["items"]);
  });

  it("stringifies non-string leaf values", () => {
    const flat = flattenKeys({ count: 5, on: true, none: null });
    expect(flat.get("count")).toBe("5");
    expect(flat.get("on")).toBe("true");
    expect(flat.get("none")).toBe("null");
  });

  it("returns an empty map for an empty object", () => {
    expect(flattenKeys({}).size).toBe(0);
  });

  it.each([
    // [input, expected flat key set]
    [{ greeting: "hi" }, ["greeting"]],
    [{ nav: { home: "Home", about: "About" } }, ["nav.home", "nav.about"]],
    [{ a: { b: { c: { d: "deep" } } } }, ["a.b.c.d"]],
  ])("flattens %j → keys %j", (input, expectedKeys) => {
    expect([...flattenKeys(input as Record<string, unknown>).keys()]).toEqual(expectedKeys);
  });
});

describe("extractICUVariables (message → sorted top-level var names)", () => {
  it.each([
    // [message, expected sorted variable names]
    ["Hello {name}", ["name"]],
    ["{count, plural, one {# item} other {# items}}", ["count"]],
    ["{a} and {b}", ["a", "b"]],
    // De-duplicated and sorted.
    ["{b} {a} {a}", ["a", "b"]],
    // No placeholders.
    ["plain text", []],
    // Nested placeholders inside a plural arm are NOT top-level vars.
    ["{count, plural, one {one {name}} other {many {name}}}", ["count"]],
    // select with a nested var only exposes the top-level selector.
    ["{gender, select, male {he} female {she} other {they {name}}}", ["gender"]],
    // Leading whitespace before the var name is tolerated.
    ["{ name }", ["name"]],
  ])("extracts vars from %j → %j", (message, expected) => {
    expect(extractICUVariables(message)).toEqual(expected);
  });

  it("returns sorted output regardless of source order", () => {
    expect(extractICUVariables("{zebra} {apple} {mango}")).toEqual(["apple", "mango", "zebra"]);
  });
});

// The gate's actual cross-locale checks (sections 1 and 6 of the script) are
// inline in main(), composed from the two exported primitives. We re-compose the
// exact same diff expressions here over synthetic locales to lock the behavior:
//   - keys in reference missing from a locale  → MISSING (error)
//   - keys in a locale absent from reference    → EXTRA (warn)
//   - ICU vars that differ between the two       → PLACEHOLDER (error)
describe("cross-locale key consistency diff (composed)", () => {
  function keyDiff(ref: Record<string, unknown>, loc: Record<string, unknown>) {
    const refKeys = flattenKeys(ref);
    const locKeys = flattenKeys(loc);
    const missingInLocale = [...refKeys.keys()].filter((k) => !locKeys.has(k));
    const extraInLocale = [...locKeys.keys()].filter((k) => !refKeys.has(k));
    return { missingInLocale, extraInLocale };
  }

  it("reports keys missing from the locale", () => {
    const { missingInLocale, extraInLocale } = keyDiff({ a: "1", b: { c: "2" } }, { a: "1" });
    expect(missingInLocale).toEqual(["b.c"]);
    expect(extraInLocale).toEqual([]);
  });

  it("reports extra keys present only in the locale", () => {
    const { missingInLocale, extraInLocale } = keyDiff({ a: "1" }, { a: "1", z: "extra" });
    expect(missingInLocale).toEqual([]);
    expect(extraInLocale).toEqual(["z"]);
  });

  it("reports both missing and extra in one diff", () => {
    const { missingInLocale, extraInLocale } = keyDiff(
      { shared: "x", onlyRef: "r" },
      { shared: "y", onlyLoc: "l" },
    );
    expect(missingInLocale).toEqual(["onlyRef"]);
    expect(extraInLocale).toEqual(["onlyLoc"]);
  });

  it("reports no differences for perfectly aligned locales", () => {
    const { missingInLocale, extraInLocale } = keyDiff(
      { nav: { home: "Home" } },
      { nav: { home: "Startseite" } },
    );
    expect(missingInLocale).toEqual([]);
    expect(extraInLocale).toEqual([]);
  });
});

describe("road-condition type catalog", () => {
  const roadConditionTypes = [
    "accident",
    "roadworks",
    "road_closure",
    "lane_closure",
    "hazard",
    "congestion",
    "weather",
    "event",
    "restriction",
    "other",
  ];

  it.each([
    ["en", en.roadConditions.type],
    ["de", de.roadConditions.type],
  ])("defines every supported road-condition type in %s", (_, typeMessages) => {
    expect(Object.keys(typeMessages)).toEqual(expect.arrayContaining(roadConditionTypes));
  });
});

describe("cross-locale ICU placeholder consistency (composed)", () => {
  function placeholdersDiffer(refValue: string, locValue: string): boolean {
    const refVars = extractICUVariables(refValue);
    const locVars = extractICUVariables(locValue);
    return JSON.stringify(refVars) !== JSON.stringify(locVars);
  }

  it.each([
    // [reference message, locale message, vars differ?]
    ["Hello {name}", "Hallo {name}", false],
    // Same vars, different order → still consistent (extractICUVariables sorts).
    ["{a} {b}", "{b} {a}", false],
    // Locale dropped a required placeholder.
    ["You have {count} items", "Sie haben Artikel", true],
    // Locale renamed a placeholder (a common, silent breakage).
    ["Hello {name}", "Hallo {nom}", true],
    // Locale added an undeclared placeholder.
    ["Hello {name}", "Hallo {name}, {extra}", true],
    // Plural selector consistency.
    [
      "{count, plural, one {# item} other {# items}}",
      "{count, plural, one {# Element} other {# Elemente}}",
      false,
    ],
  ])("ref=%j loc=%j → differ=%s", (refValue, locValue, expected) => {
    expect(placeholdersDiffer(refValue, locValue)).toBe(expected);
  });
});
