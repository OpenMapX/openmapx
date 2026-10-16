import { describe, expect, it } from "vitest";
import { buildCostingOptions } from "./provider";

describe("Valhalla cycling fallback preferences", () => {
  it.each([
    ["trekking", "hybrid"],
    ["road", "road"],
    ["gravel", "cross"],
    ["mountain", "mountain"],
  ] as const)("maps %s bikes", (bikeProfile, bicycle_type) =>
    expect(buildCostingOptions({ bikeProfile }, "bicycle")).toMatchObject({ bicycle_type }),
  );
  it("keeps hills and quieter roads meaningful on fallback", () =>
    expect(
      buildCostingOptions(
        { bikeHillPreference: "strongly-avoid", bikePreferQuietRoads: true },
        "bicycle",
      ),
    ).toMatchObject({ use_hills: 0, use_roads: 0.1 }));
  it("does not apply bike preferences to other modes", () =>
    expect(
      buildCostingOptions(
        { bikeProfile: "mountain", bikeHillPreference: "avoid", bikePreferQuietRoads: true },
        "auto",
      ),
    ).not.toHaveProperty("bicycle_type"));
});
