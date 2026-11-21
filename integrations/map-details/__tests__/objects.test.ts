import { describe, expect, it } from "vitest";
import type { DecodedTile, TileFeature } from "../web/derive/decode";
import { INSTANCE_STRIDE, type Instances } from "../web/derive/forest";
import type { Pt } from "../web/derive/geometry";
import { streetObjects } from "../web/derive/objects";
import { metresPerUnit } from "../web/derive/units";
import { ALEXANDERPLATZ, fixtureTile, streetFixture } from "./fixtures";

const EXTENT = 4096;
const CELL = { x: 35209, y: 21492 };
const MPU = metresPerUnit(16, CELL.y, EXTENT);
/** Scene metres (x east, y north of the cell's south-west corner) to tile units. */
const unitsOf = ([x, y]: Pt): Pt => [x / MPU, EXTENT - y / MPU];

type Props = Record<string, string | number | boolean>;
const point = (props: Props, p: Pt): TileFeature => ({ type: 1, geometry: [[unitsOf(p)]], props });
const line = (props: Props, ...points: Pt[]): TileFeature => ({
  type: 2,
  geometry: [points.map(unitsOf)],
  props: { oneway: 0, layer: 0, ...props },
});
function tile(layers: Partial<Record<string, TileFeature[]>>): DecodedTile {
  return {
    extent: EXTENT,
    layers: {
      roads: [],
      rails: [],
      crossings: [],
      trees: [],
      furniture: [],
      pitches: [],
      ...layers,
    } as Record<string, TileFeature[]>,
  };
}

interface Placed {
  kind: string;
  x: number;
  y: number;
  bearing: number;
  height: number;
  crown: number;
  mapped: number;
}
function placed(instances: Instances[]): Placed[] {
  return instances.flatMap((set) =>
    Array.from({ length: set.count }, (_, i) => {
      const d = set.data.subarray(i * INSTANCE_STRIDE, (i + 1) * INSTANCE_STRIDE);
      const bearing = ((((-(d[2] as number) * 180) / Math.PI) % 360) + 360) % 360;
      return {
        kind: set.kind,
        x: d[0] as number,
        y: d[1] as number,
        bearing: Math.round(bearing * 1000) / 1000,
        height: d[3] as number,
        crown: d[4] as number,
        mapped: d[7] as number,
      };
    }),
  );
}
const objects = (layers: Partial<Record<string, TileFeature[]>>, leftHand = false) =>
  placed(streetObjects(tile(layers), CELL, leftHand));

/** A two-way primary road (6.5 m wide) running east through (100, 200) as an interior vertex. */
const ROAD = line({ class: "primary", lanes: 2 }, [0, 200], [100, 200], [300, 200]);

describe("street trees", () => {
  it("picks conifers for needle-leaved trees and marks them mapped", () => {
    const [needle, broad] = objects({
      trees: [point({ leaf: "needleleaved" }, [10, 10]), point({ leaf: "broadleaved" }, [20, 10])],
    });
    expect(needle).toMatchObject({ kind: "conifer", mapped: 1 });
    expect(broad).toMatchObject({ kind: "broadleaf", mapped: 1 });
    expect(needle?.x).toBeCloseTo(10, 3);
    expect(needle?.y).toBeCloseTo(10, 3);
  });

  it.each<[Props, number, number]>([
    [{ height: 18, crown: 9 }, 18, 9],
    [{ crown: 6 }, 10, 6],
    [{ circ: 1 }, 46 / Math.PI, (0.6 * 46) / Math.PI],
    [{}, 10, 6],
    [{ height: 80, crown: 50, circ: 20 }, 10, 6],
  ])("sizes %j at %f m with a %f m crown", (props, height, crown) => {
    const [tree] = objects({ trees: [point(props, [10, 10])] });
    expect(tree?.height).toBeCloseTo(height, 3);
    expect(tree?.crown).toBeCloseTo(crown, 3);
  });

  it("plants a tree row every 8 ± 1 m", () => {
    const row = objects({ trees: [line({}, [10, 50], [110, 50])] });
    expect(row.length).toBeGreaterThanOrEqual(12);
    expect(row.length).toBeLessThanOrEqual(14);
    const xs = row.map((t) => t.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) {
      expect((xs[i] as number) - (xs[i - 1] as number)).toBeGreaterThanOrEqual(6 - 1e-3);
      expect((xs[i] as number) - (xs[i - 1] as number)).toBeLessThanOrEqual(10 + 1e-3);
    }
    expect(row.every((t) => t.height === 10)).toBe(true);
  });
});

describe("street lamps", () => {
  it("skips wall and suspended lamps and gives straight masts a lantern", () => {
    const lamps = objects({
      furniture: [
        point({ kind: "lamp", mount: "wall" }, [10, 10]),
        point({ kind: "lamp", mount: "suspended" }, [20, 10]),
        point({ kind: "lamp", mount: "straight_mast" }, [30, 10]),
        point({ kind: "lamp", mount: "bent_mast" }, [40, 10]),
        point({ kind: "lamp" }, [50, 10]),
      ],
    });
    expect(lamps.map((l) => l.kind).sort()).toEqual(["lamp_arm", "lamp_arm", "lamp_lantern"]);
  });

  it("points the arm at the nearest road within 15 m", () => {
    const [lamp] = objects({ roads: [ROAD], furniture: [point({ kind: "lamp" }, [150, 210])] });
    expect(lamp?.bearing).toBeCloseTo(180, 3);
    expect(lamp?.height).toBe(6);
  });
});

describe("traffic signals", () => {
  it("stands a pole at each carriageway edge of a mid-way signal, facing its traffic", () => {
    const poles = objects({ roads: [ROAD], furniture: [point({ kind: "signals" }, [100, 200])] });
    expect(poles).toHaveLength(2);
    const south = poles.find((p) => p.y < 200);
    const north = poles.find((p) => p.y > 200);
    expect(south?.y).toBeCloseTo(200 - 3.25, 3);
    expect(north?.y).toBeCloseTo(200 + 3.25, 3);
    // Forward (eastbound) traffic keeps right and faces its pole from the west.
    expect(south?.bearing).toBeCloseTo(270, 3);
    expect(north?.bearing).toBeCloseTo(90, 3);
  });

  it("mirrors the poles in left-hand traffic", () => {
    const poles = objects(
      { roads: [ROAD], furniture: [point({ kind: "signals" }, [100, 200])] },
      true,
    );
    expect(poles.find((p) => p.y > 200)?.bearing).toBeCloseTo(270, 3);
    expect(poles.find((p) => p.y < 200)?.bearing).toBeCloseTo(90, 3);
  });

  it("keeps only the forward pole for traffic_signals:direction=forward", () => {
    const poles = objects({
      roads: [ROAD],
      furniture: [point({ kind: "signals", sig_dir: "forward" }, [100, 200])],
    });
    expect(poles).toHaveLength(1);
    expect(poles[0]?.bearing).toBeCloseTo(270, 3);
  });

  it("ignores the direction at a road's end", () => {
    const poles = objects({
      roads: [line({ class: "primary", lanes: 2 }, [100, 200], [300, 200])],
      furniture: [point({ kind: "signals", sig_dir: "forward" }, [100, 200])],
    });
    expect(poles).toHaveLength(2);
  });

  it("stands a single pole with no road nearby", () => {
    expect(objects({ furniture: [point({ kind: "signals" }, [100, 100])] })).toHaveLength(1);
  });
});

describe("benches", () => {
  it("faces a mapped direction", () => {
    const [bench] = objects({ furniture: [point({ kind: "bench", dir: "S" }, [50, 50])] });
    expect(bench).toMatchObject({ kind: "bench", bearing: 180 });
  });

  it("faces away from the nearest road within 10 m", () => {
    const [bench] = objects({ roads: [ROAD], furniture: [point({ kind: "bench" }, [150, 206])] });
    expect(bench?.bearing).toBeCloseTo(0, 3);
  });

  it("skips a bench within 1 m of a road centreline", () => {
    expect(objects({ roads: [ROAD], furniture: [point({ kind: "bench" }, [150, 200.5])] })).toEqual(
      [],
    );
  });
});

describe("cell bounds", () => {
  it("drops anchors outside the cell", () => {
    const outside = objects({
      trees: [point({}, [-5, 10]), point({}, [10, -5]), point({}, [10, 10])],
    });
    expect(outside).toHaveLength(1);
  });
});

describe("Alexanderplatz fixture", () => {
  it("places trees, lamps and signals", () => {
    const street = streetFixture(ALEXANDERPLATZ);
    const { x, y } = fixtureTile(ALEXANDERPLATZ);
    const kinds = new Set(placed(streetObjects(street, { x, y }, false)).map((p) => p.kind));
    expect(kinds.has("broadleaf")).toBe(true);
    expect(kinds.has("signal")).toBe(true);
    expect([...kinds].some((k) => k.startsWith("lamp_"))).toBe(true);
  });
});
