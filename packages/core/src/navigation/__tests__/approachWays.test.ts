import { describe, expect, it } from "vitest";
import type { LngLat } from "../../types/geometry";
import { approachWayIdsFromWindow } from "../approachWays";

// ~1 m of latitude in degrees.
const M = 1 / 111_195;
const geometry: LngLat[] = [
  [0, 0],
  [0, 100 * M],
  [0, 200 * M],
  [0, 300 * M],
];

describe("approachWayIdsFromWindow", () => {
  it("picks the last edge ending at the manoeuvre point", () => {
    const ids = approachWayIdsFromWindow([{ stepIndex: 2, point: [0, 200 * M] }], {
      geometry,
      edges: [
        { wayId: 11, endShapeIndex: 1 },
        // Two edges end at the manoeuvre (a split way); the later one is the approach.
        { wayId: 22, endShapeIndex: 2 },
        { wayId: 23, endShapeIndex: 2 },
        { wayId: 33, endShapeIndex: 3 },
      ],
    });
    expect(ids).toEqual({ 2: 23 });
  });

  it("prefers the edge ending at the junction over a short outgoing piece within 5 m", () => {
    const withStub: LngLat[] = [...geometry.slice(0, 3), [0, 203 * M], [0, 300 * M]];
    const ids = approachWayIdsFromWindow([{ stepIndex: 2, point: [0, 200 * M] }], {
      geometry: withStub,
      edges: [
        { wayId: 11, endShapeIndex: 1 },
        { wayId: 22, endShapeIndex: 2 },
        // The outgoing way is split 3 m past the junction.
        { wayId: 44, endShapeIndex: 3 },
        { wayId: 45, endShapeIndex: 4 },
      ],
    });
    expect(ids).toEqual({ 2: 22 });
  });

  it("accepts an edge end within 5 m", () => {
    const ids = approachWayIdsFromWindow([{ stepIndex: 1, point: [0, 104 * M] }], {
      geometry,
      edges: [{ wayId: 11, endShapeIndex: 1 }],
    });
    expect(ids).toEqual({ 1: 11 });
  });

  it("no edge within 5 m gives no id", () => {
    const ids = approachWayIdsFromWindow([{ stepIndex: 1, point: [0, 150 * M] }], {
      geometry,
      edges: [
        { wayId: 11, endShapeIndex: 1 },
        { wayId: 22, endShapeIndex: 2 },
      ],
    });
    expect(ids).toEqual({});
  });
});
