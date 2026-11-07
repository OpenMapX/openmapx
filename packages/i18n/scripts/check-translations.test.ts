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

describe("road-condition classification catalog", () => {
  const kinds = [
    "incident",
    "roadworks",
    "closure",
    "restriction",
    "weather_condition",
    "road_condition",
    "road_hazard",
    "public_event",
    "authority",
    "equipment_fault",
    "security",
    "winter_operation",
    "pass_status",
    "congestion",
    "other",
  ];
  const types = [
    "accident",
    "breakdown",
    "vehicle_hazard",
    "obstruction",
    "fire",
    "works",
    "closure",
    "dimension",
    "access",
    "speed",
    "seasonal_load",
    "weather",
    "surface",
    "driving_condition",
    "hazard",
    "event",
    "operation",
    "fault",
    "incident",
    "chain_control",
    "pass",
    "congestion",
    "other",
  ];

  it.each([
    ["en", en],
    ["de", de],
  ])("defines every registry kind and type in %s", (_, messages) => {
    expect(Object.keys(messages.roadConditions.kind)).toEqual(expect.arrayContaining(kinds));
    expect(Object.keys(messages.roadConditions.type)).toEqual(expect.arrayContaining(types));
    expect(Object.keys(messages.navigation.incidentType)).toEqual(expect.arrayContaining(types));
  });
});
