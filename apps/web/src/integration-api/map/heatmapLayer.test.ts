import { describe, expect, it } from "vitest";
import { createHeatmapPaint } from "./heatmapLayer";

describe("heatmap paint", () => {
  it("builds the common paint around each source's weight domain", () => {
    expect(createHeatmapPaint("mag", 8)).toEqual({
      "heatmap-weight": ["interpolate", ["linear"], ["get", "mag"], 0, 0, 8, 1],
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 1, 9, 3],
      "heatmap-color": [
        "interpolate",
        ["linear"],
        ["heatmap-density"],
        0,
        "rgba(0,0,0,0)",
        0.2,
        "#ffffb2",
        0.4,
        "#fecc5c",
        0.6,
        "#fd8d3c",
        0.8,
        "#f03b20",
        1,
        "#bd0026",
      ],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 4, 9, 30],
      "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 7, 1, 12, 0],
    });
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
