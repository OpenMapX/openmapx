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

describe("Valhalla surface, pace and hill calibration", () => {
  it.each([
    ["road", 0.75],
    ["trekking", 0.5],
    ["gravel", 0.25],
    ["mountain", 0.1],
  ] as const)("uses bike-appropriate surfaces for %s", (bikeProfile, avoid_bad_surfaces) => {
    expect(buildCostingOptions({ bikeProfile }, "bicycle")).toMatchObject({ avoid_bad_surfaces });
    expect(
      buildCostingOptions({ bikeProfile, bikePreferSmoothSurfaces: true }, "bicycle"),
    ).toMatchObject({ avoid_bad_surfaces: 0.9 });
  });
  it("distinguishes all hill settings without weakening the upstream default", () => {
    expect(buildCostingOptions({}, "bicycle")).not.toHaveProperty("use_hills");
    expect(buildCostingOptions({ bikeHillPreference: "avoid" }, "bicycle")).toHaveProperty(
      "use_hills",
      0.1,
    );
    expect(buildCostingOptions({ bikeHillPreference: "strongly-avoid" }, "bicycle")).toHaveProperty(
      "use_hills",
      0,
    );
  });
  it("keeps automatic speed and honors an explicit cruising speed", () => {
    expect(buildCostingOptions({}, "bicycle")).not.toHaveProperty("cycling_speed");
    expect(buildCostingOptions({ bikeSpeedKmh: 19.5 }, "bicycle")).toHaveProperty(
      "cycling_speed",
      19.5,
    );
    expect(
      buildCostingOptions({ bikeSpeedKmh: 20, bikePreferSmoothSurfaces: true }, "auto"),
    ).not.toHaveProperty("cycling_speed");
  });
});
