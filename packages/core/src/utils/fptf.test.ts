import { describe, expect, it } from "vitest";
import { mapFptfLoadFactor, normalizeFptfDeparture } from "./fptf";

describe("mapFptfLoadFactor", () => {
  it("maps the four DB load-factor levels to OccupancyLevel", () => {
    expect(mapFptfLoadFactor("low-to-medium")).toBe("low");
    expect(mapFptfLoadFactor("high")).toBe("medium");
    expect(mapFptfLoadFactor("very-high")).toBe("high");
    expect(mapFptfLoadFactor("exceptionally-high")).toBe("overcrowded");
  });

  it("returns undefined for missing or unknown values", () => {
    expect(mapFptfLoadFactor(undefined)).toBeUndefined();
    expect(mapFptfLoadFactor("")).toBeUndefined();
    expect(mapFptfLoadFactor("nonsense")).toBeUndefined();
  });
});

describe("normalizeFptfDeparture occupancy", () => {
  it("derives occupancy from the FPTF loadFactor field", () => {
    const dep = normalizeFptfDeparture(
      { line: { name: "ICE 1", product: "nationalExpress" }, loadFactor: "very-high" },
      "db:",
    );
    expect(dep.occupancy).toBe("high");
  });

  it("leaves occupancy undefined when no loadFactor is present", () => {
    const dep = normalizeFptfDeparture({ line: { name: "RB 1", product: "regional" } }, "db:");
    expect(dep.occupancy).toBeUndefined();
  });
});
