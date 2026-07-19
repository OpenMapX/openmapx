import { describe, expect, it } from "vitest";
import { nextSatelliteLayer } from "./satelliteToggle";

describe("nextSatelliteLayer", () => {
  it("turns satellite on from any base layer", () => {
    expect(nextSatelliteLayer(false, "default")).toBe("satellite");
    expect(nextSatelliteLayer(false, "cycling")).toBe("satellite");
  });

  it("restores the last non-satellite base layer when turning off", () => {
    expect(nextSatelliteLayer(true, "terrain")).toBe("terrain");
    expect(nextSatelliteLayer(true, "default")).toBe("default");
  });
});
