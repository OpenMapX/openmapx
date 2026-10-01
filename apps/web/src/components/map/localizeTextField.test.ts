// @vitest-environment node
import { describe, expect, it } from "vitest";
import { localizeTextField } from "./localizeTextField";

const GERMAN = ["coalesce", ["get", "name:de"], ["get", "name"]];

describe("localizeTextField", () => {
  it("turns a legacy name token into the localized name", () => {
    expect(localizeTextField("{name:latin}\n{name:nonlatin}", "de")).toEqual(GERMAN);
    expect(localizeTextField(["coalesce", ["get", "name:latin"], ["get", "name"]], "de")).toEqual(
      GERMAN,
    );
  });

  it("changes only the name inside a larger label", () => {
    const peak = [
      "concat",
      ["get", "name"],
      ["case", ["has", "ele"], ["concat", "\n", ["to-string", ["get", "ele"]], " m"], ""],
    ];
    expect(localizeTextField(peak, "de")).toEqual([
      "concat",
      GERMAN,
      ["case", ["has", "ele"], ["concat", "\n", ["to-string", ["get", "ele"]], " m"], ""],
    ]);

    const stopsUnnamed = ["case", ["==", ["get", "class"], "bus"], "", ["get", "name"]];
    expect(localizeTextField(stopsUnnamed, "de")).toEqual([
      "case",
      ["==", ["get", "class"], "bus"],
      "",
      GERMAN,
    ]);
  });

  it("switches language when run again, without nesting", () => {
    const english = localizeTextField(GERMAN, "en");
    expect(english).toEqual(["coalesce", ["get", "name:en"], ["get", "name"]]);
    expect(localizeTextField(english, "en")).toEqual(english);
  });

  it("leaves labels that show no name alone", () => {
    expect(localizeTextField(["get", "housenumber"], "de")).toEqual(["get", "housenumber"]);
    expect(localizeTextField("{ref}", "de")).toBe("{ref}");
    const literal = ["match", ["get", "class"], ["literal", ["name"]], "x", "y"];
    expect(localizeTextField(literal, "de")).toEqual(literal);
  });
});
