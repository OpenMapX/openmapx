import { describe, expect, it } from "vitest";
import { bboxAroundPoint } from "./bbox";

describe("bboxAroundPoint", () => {
  it("returns a box centered on the point", () => {
    const bbox = bboxAroundPoint([13.405, 52.52], 1000);
    expect((bbox.west + bbox.east) / 2).toBeCloseTo(13.405, 5);
    expect((bbox.south + bbox.north) / 2).toBeCloseTo(52.52, 5);
  });

  it("spans ~2x the radius in latitude (north-south)", () => {
    const bbox = bboxAroundPoint([13.405, 52.52], 1000);
    const latSpanMetres = (bbox.north - bbox.south) * 111_320;
    expect(latSpanMetres).toBeCloseTo(2000, -1);
  });

  it("widens longitude span with latitude (cos correction)", () => {
    const equator = bboxAroundPoint([0, 0], 1000);
    const high = bboxAroundPoint([0, 60], 1000);
    const equatorLonSpan = equator.east - equator.west;
    const highLonSpan = high.east - high.west;
    expect(highLonSpan).toBeCloseTo(equatorLonSpan * 2, 4);
  });
});
