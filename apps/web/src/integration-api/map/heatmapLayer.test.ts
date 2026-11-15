import { describe, expect, it } from "vitest";
import { createHeatmapPaint } from "./heatmapLayer";

describe("heatmap paint", () => {
  it("builds the common paint around each source's weight domain", () => {
    expect(createHeatmapPaint("mag", 8)["heatmap-weight"]).toEqual([
      "interpolate",
      ["linear"],
      ["get", "mag"],
      0,
      0,
      8,
      1,
    ]);
    expect(createHeatmapPaint("frp", 1000)["heatmap-weight"]).toEqual([
      "interpolate",
      ["linear"],
      ["get", "frp"],
      0,
      0,
      1000,
      1,
    ]);
  });
});
