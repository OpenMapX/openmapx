import { describe, expect, it } from "vitest";
import { INSTANCE_STRIDE, type Instances, type ModelKind } from "../web/derive/forest";
import { EARTH_CIRCUMFERENCE_M, tileCentreLat } from "../web/derive/units";
import {
  CELL_CACHE_SIZE,
  cellKey,
  MAX_CELLS,
  type Selection,
  selectInstances,
  visibleCells,
} from "../web/selection";

const N = 2 ** 16;
const lngOf = (x: number) => (x / N) * 360 - 180;
const latOf = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / N))) * 180) / Math.PI;
const CELL = { x: 35209, y: 21492 };
const SIZE = (EARTH_CIRCUMFERENCE_M * Math.cos((tileCentreLat(16, CELL.y) * Math.PI) / 180)) / N;

/** Instances at (x, y) metres in a cell, one row per point. */
function instances(kind: ModelKind, points: Array<[number, number]>): Instances {
  const data = new Float32Array(points.length * INSTANCE_STRIDE);
  for (const [i, [x, y]] of points.entries())
    data.set([x, y, 0, 10, 6, 0, 0, 1], i * INSTANCE_STRIDE);
  return { kind, count: points.length, data };
}
const count = (sets: Selection["near"]) => sets.reduce((s, set) => s + set.count, 0);

describe("visible cells", () => {
  it("covers the view with a one-cell ring", () => {
    const west = lngOf(CELL.x + 0.2);
    const east = lngOf(CELL.x + 1.8);
    const north = latOf(CELL.y + 0.2);
    const south = latOf(CELL.y + 0.8);
    const cells = visibleCells([west, south, east, north], 17);
    const keys = new Set(cells.map((c) => cellKey(c.x, c.y)));
    for (let x = CELL.x - 1; x <= CELL.x + 2; x++)
      for (let y = CELL.y - 1; y <= CELL.y + 1; y++) expect(keys.has(cellKey(x, y))).toBe(true);
    expect(cells).toHaveLength(12);
  });

  it("caches more cells than a view can show, so visible cells are never evicted", () => {
    expect(MAX_CELLS).toBe(400);
    expect(CELL_CACHE_SIZE).toBeGreaterThan(MAX_CELLS);
  });

  it("lists a world-wide view without enumerating every cell", () => {
    const cells = visibleCells([-180, -85, 180, 85], 17);
    expect(cells).toHaveLength(400);
  });

  it("caps the count at 400 cells nearest the view centre", () => {
    const cells = visibleCells(
      [lngOf(CELL.x - 40), latOf(CELL.y + 40), lngOf(CELL.x + 40), latOf(CELL.y - 40)],
      16,
    );
    expect(cells).toHaveLength(400);
    expect(cells.some((c) => c.x === CELL.x && c.y === CELL.y)).toBe(true);
  });
});

describe("instance selection", () => {
  const camera = { lng: lngOf(CELL.x + 0.5), lat: latOf(CELL.y + 0.5) };

  it("takes the nearest instances within each class budget and splits near from far", () => {
    const centre = SIZE / 2;
    const cells = new Map([
      [
        cellKey(CELL.x, CELL.y),
        [
          instances("broadleaf", [
            [centre + 10, centre],
            [centre + 300, centre],
            [centre, centre + 360],
            [centre - 50, centre],
          ]),
          instances("lamp_arm", [
            [centre + 5, centre],
            [centre + 100, centre],
          ]),
        ],
      ],
    ]);
    const selection = selectInstances(cells, camera, { trees: 3, furniture: 1 }, 17);
    expect(count(selection.near)).toBe(4);
    expect(count(selection.far)).toBe(0);
    const near = selection.near.find((s) => s.kind === "broadleaf");
    // The 360 m tree is the farthest and falls outside the budget of three.
    const xs = Array.from({ length: near?.count ?? 0 }, (_, i) => near?.data[i * INSTANCE_STRIDE]);
    expect(xs.sort()).toEqual(
      [centre - 50, centre + 10, centre + 300].map((v) => Math.fround(v)).sort(),
    );
    expect(selection.near.find((s) => s.kind === "lamp_arm")?.count).toBe(1);
    expect(selection.cells).toEqual([{ key: cellKey(CELL.x, CELL.y), x: CELL.x, y: CELL.y }]);
    expect(Array.from(near?.cell ?? [])).toEqual([0, 0, 0]);

    const far = selectInstances(cells, camera, { trees: 10, furniture: 10 }, 17, 200);
    expect(far.far.find((s) => s.kind === "broadleaf")?.count).toBe(2);
  });

  it("orders by distance across cells, including the ring", () => {
    const cells = new Map([
      [cellKey(CELL.x, CELL.y), [instances("conifer", [[SIZE / 2, SIZE / 2]])]],
      [cellKey(CELL.x + 1, CELL.y), [instances("conifer", [[1, SIZE / 2]])]],
      [cellKey(CELL.x + 2, CELL.y), [instances("conifer", [[1, SIZE / 2]])]],
    ]);
    const selection = selectInstances(cells, camera, { trees: 2, furniture: 0 }, 17);
    const conifers = selection.near.find((s) => s.kind === "conifer");
    expect(conifers?.count).toBe(2);
    const usedCells = new Set(Array.from(conifers?.cell ?? []).map((i) => selection.cells[i]?.x));
    expect(usedCells).toEqual(new Set([CELL.x, CELL.x + 1]));
  });

  it("leaves furniture out below zoom 17", () => {
    const cells = new Map([
      [
        cellKey(CELL.x, CELL.y),
        [
          instances("bench", [[SIZE / 2, SIZE / 2]]),
          instances("broadleaf", [[SIZE / 2, SIZE / 2]]),
        ],
      ],
    ]);
    const selection = selectInstances(cells, camera, { trees: 10, furniture: 10 }, 16.5);
    expect(selection.near.map((s) => s.kind)).toEqual(["broadleaf"]);
  });
});
