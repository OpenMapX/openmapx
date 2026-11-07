import { describe, expect, it } from "vitest";
import { SCHEMATIC_LAYOUTS, SCHEMATIC_NETWORKS } from "./store.js";

describe("schematic transit store", () => {
  it("offers every supported variant exactly once, geo-octi excluded", () => {
    expect(SCHEMATIC_NETWORKS.map((n) => n.id)).toEqual([
      "tram",
      "subway-lightrail",
      "rail-commuter",
      "rail",
    ]);
    expect(SCHEMATIC_LAYOUTS.map((l) => l.id)).toEqual(["geo", "octi", "orthorad"]);
  });
});
