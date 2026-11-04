import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { TRAFFIC_FLOW_WITH_DATA_FILTER } from "../visual-style";

const requireFromMapLibre = createRequire(import.meta.resolve("maplibre-gl/package.json"));
const styleSpec = requireFromMapLibre("@maplibre/maplibre-gl-style-spec") as {
  featureFilter: (
    filter: unknown,
    rootKey: string,
  ) => {
    filter: (
      globals: { zoom: number },
      feature: { type: 2; properties: Record<string, unknown> },
    ) => boolean;
  };
};

const drawn = (properties: Record<string, unknown>) =>
  styleSpec
    .featureFilter(TRAFFIC_FLOW_WITH_DATA_FILTER, "filter")
    .filter({ zoom: 12 }, { type: 2, properties });

describe("traffic flow data filter", () => {
  it("leaves out a road segment without any traffic data", () => {
    // ST_AsMVT omits NULL columns, so such a segment carries only its identity.
    expect(drawn({ segment_id: "s1", dir: "f", highway: "primary" })).toBe(false);
    expect(drawn({ segment_id: "s1", los: "unknown", confidence: "typical" })).toBe(false);
  });

  it("draws a segment with a measured ratio or a declared level", () => {
    expect(drawn({ speed_ratio: 0.95, los: "free_flow", confidence: "measured" })).toBe(true);
    expect(drawn({ speed_ratio: 0.4, los: "unknown", confidence: "estimated" })).toBe(true);
    expect(drawn({ los: "queuing", confidence: "measured" })).toBe(true);
    expect(drawn({ los: "free_flow", confidence: "measured" })).toBe(true);
  });
});
