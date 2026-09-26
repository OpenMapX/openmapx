import { describe, expect, it } from "vitest";
import { selectResultAttributes } from "./resultAttributes";

describe("result attribute selection", () => {
  it("keeps the two most useful known values in priority order", () => {
    expect(
      selectResultAttributes({
        cuisine: "italian; pizza",
        outdoor_seating: "yes",
        wheelchair: "limited",
      }),
    ).toEqual([{ kind: "cuisine", value: "Italian, pizza" }, { kind: "outdoor_seating" }]);
  });

  it("preserves the distinct limited accessibility meaning", () => {
    expect(selectResultAttributes({ wheelchair: "limited", outdoor_seating: "no" })).toEqual([
      { kind: "wheelchair_limited" },
    ]);
  });

  it("omits unknown, empty and unrecognized values", () => {
    expect(
      selectResultAttributes({
        cuisine: "unknown; ;",
        outdoor_seating: "unknown",
        wheelchair: "maybe",
      }),
    ).toEqual([]);
    expect(selectResultAttributes(undefined)).toEqual([]);
  });

  it("drops cuisine placeholders while preserving ordinary free-form values", () => {
    expect(
      selectResultAttributes({
        cuisine: "fixme; n/a; none; undefined; null; ?; smoked_fish",
        outdoor_seating: "yes",
      }),
    ).toEqual([{ kind: "cuisine", value: "Smoked fish" }, { kind: "outdoor_seating" }]);
    expect(selectResultAttributes({ cuisine: "N/A; FixMe; none", wheelchair: "limited" })).toEqual([
      { kind: "wheelchair_limited" },
    ]);
  });
});
