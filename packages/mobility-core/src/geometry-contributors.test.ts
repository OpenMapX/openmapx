import { describe, expect, it } from "vitest";
import { captureGeometryContributors, parseGeometryContributors } from "./geometry-contributors";

const a = { sourceId: "same", name: "A", publisher: { name: "Old publisher" } };
describe("geometry contributor partitions", () => {
  it("copies receipts and fills unknown edges without borrowing the record union", () => {
    const route = {
      geometry: [0, 1, 2, 3],
      contributors: [a],
      geometryContributors: [{ startIndex: 1, endIndex: 2, contributors: [a] }],
    };
    const spans = captureGeometryContributors(route);
    expect(spans).toEqual([
      { startIndex: 0, endIndex: 1, contributors: [] },
      route.geometryContributors[0],
      { startIndex: 2, endIndex: 3, contributors: [] },
    ]);
    expect(spans[1].contributors?.[0].publisher).not.toBe(a.publisher);
    expect(captureGeometryContributors({ ...route, geometryContributors: [] })).toEqual([
      { startIndex: 0, endIndex: 3, contributors: [] },
    ]);
  });
  it("rejects overlapping or out-of-range spans and leaves legacy unknown", () => {
    expect(
      parseGeometryContributors([{ startIndex: 0, endIndex: 3, contributors: [] }], 3),
    ).toBeUndefined();
    expect(
      parseGeometryContributors(
        [
          { startIndex: 0, endIndex: 2, contributors: [] },
          { startIndex: 1, endIndex: 2, contributors: [] },
        ],
        3,
      ),
    ).toBeUndefined();
    expect(captureGeometryContributors({ geometry: [0, 1] })).toEqual([
      { startIndex: 0, endIndex: 1, contributors: [] },
    ]);
    expect(
      captureGeometryContributors({
        geometry: [0, 1],
        contributors: [a],
        fieldContributors: { duration: [a] },
      })[0].contributors,
    ).toEqual([]);
  });
});
