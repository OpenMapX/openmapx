import { describe, expect, it } from "vitest";
import type { RoadFlowQuery, RoadFlowSegment } from "../roadConditions";

describe("RoadFlowSegment", () => {
  it("accepts the documented shape", () => {
    const s: RoadFlowSegment = {
      id: "1:f",
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
      los: "heavy",
      confidence: "measured",
      direction: "f",
    };
    expect(s.id).toBe("1:f");
  });

  it("allows the optional speed/attribution fields", () => {
    const s: RoadFlowSegment = {
      id: "2:b",
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
      currentSpeedKph: 42,
      freeFlowSpeedKph: 80,
      speedRatio: 0.525,
      los: "queuing",
      confidence: "estimated",
      direction: "b",
      roads: "A1",
      source: "ndw",
      observedAt: "2026-07-09T00:00:00.000Z",
    };
    expect(s.speedRatio).toBeCloseTo(0.525);
  });
});

describe("RoadFlowQuery", () => {
  it("allows the optional minLos filter", () => {
    const q: RoadFlowQuery = { minLos: "heavy" };
    expect(q.minLos).toBe("heavy");

    const empty: RoadFlowQuery = {};
    expect(empty.minLos).toBeUndefined();
  });
});
