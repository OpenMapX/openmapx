import { describe, expect, it } from "vitest";
import { crossingMarking, crossingPaint } from "../web/derive/crossings";
import type { TileFeature } from "../web/derive/decode";
import { type Pt, type Ring, ringArea } from "../web/derive/geometry";
import { crossSection } from "../web/derive/roads";

const MPU = 0.1;
type Props = Record<string, string | number | boolean>;

const line = (props: Props, ...points: Pt[]): TileFeature => ({
  type: 2,
  geometry: [points.map(([x, y]): Pt => [x / MPU, y / MPU])],
  props: { oneway: 0, layer: 0, ...props },
});
const node = (props: Props, [x, y]: Pt): TileFeature => ({
  type: 1,
  geometry: [[[x / MPU, y / MPU]]],
  props,
});

/** A west–east road at y = 100 that is 7 m wide (two 3.5 m motorway-class lanes). */
const ROAD = line({ class: "trunk", lanes: 2 }, [0, 100], [200, 100]);

function paint(crossings: TileFeature[], roads = [ROAD]) {
  return crossingPaint(
    crossings,
    roads,
    roads.map((r) => crossSection(r.props, false)),
    MPU,
  );
}
const rings = (polygons: ReturnType<typeof paint>) => polygons.flatMap((p) => p.rings);
const bounds = (all: Ring[]) => {
  const points = all.flat();
  return {
    minX: Math.min(...points.map((p) => p[0])),
    maxX: Math.max(...points.map((p) => p[0])),
    minY: Math.min(...points.map((p) => p[1])),
    maxY: Math.max(...points.map((p) => p[1])),
  };
};

describe("crossing markings", () => {
  it.each<[Props, ReturnType<typeof crossingMarking>]>([
    [{ markings: "zebra" }, "zebra"],
    [{ markings: "yes" }, "zebra"],
    [{ markings: "ladder" }, "zebra"],
    [{ markings: "ladder:skewed" }, "zebra"],
    [{ markings: "ladder:paired" }, "zebra"],
    [{ markings: "lines" }, "lines"],
    [{ markings: "lines:paired" }, "lines"],
    [{ markings: "dashes" }, "dashed_lines"],
    [{ markings: "dots" }, "dashed_lines"],
    [{ markings: "no", crossing: "zebra" }, null],
    [{ markings: "surface" }, null],
    [{ markings: "pictograms" }, null],
    [{ crossing: "zebra" }, "zebra"],
    [{ crossing: "marked" }, "zebra"],
    [{ crossing_ref: "zebra" }, "zebra"],
    [{ crossing: "traffic_signals" }, "lines"],
    [{ crossing: "uncontrolled" }, null],
    [{}, null],
  ])("reads %j as %s", (props, expected) => {
    expect(crossingMarking(props)).toBe(expected);
  });
});

describe("crossing paint", () => {
  it("stripes a zebra line across the crossed carriageway: seven stripes for 7 m", () => {
    const polygons = paint([line({ markings: "zebra" }, [100, 90], [100, 110])]);
    expect(polygons.every((p) => p.kind === "marking")).toBe(true);
    const stripes = rings(polygons);
    expect(stripes).toHaveLength(7);
    for (const stripe of stripes) expect(Math.abs(ringArea(stripe))).toBeCloseTo(0.5 * 3, 6);
    const box = bounds(stripes);
    expect(box.maxY - box.minY).toBeCloseTo(6.5, 6);
    expect(box.maxX - box.minX).toBeCloseTo(3, 6);
    expect((box.minY + box.maxY) / 2).toBeCloseTo(100, 6);
  });

  it("draws two 0.2 m lines 3 m apart over the carriageway", () => {
    const polygons = paint([line({ crossing: "traffic_signals" }, [100, 90], [100, 110])]);
    const all = rings(polygons);
    expect(all).toHaveLength(2);
    for (const ring of all) expect(Math.abs(ringArea(ring))).toBeCloseTo(0.2 * 7, 6);
    const xs = all.map((ring) => bounds([ring])).map((b) => (b.minX + b.maxX) / 2);
    expect(Math.abs((xs[0] ?? 0) - (xs[1] ?? 0))).toBeCloseTo(3, 6);
  });

  it("dashes the lines for dashes and dots", () => {
    const all = rings(paint([line({ markings: "dashes" }, [100, 90], [100, 110])]));
    expect(all.length).toBeGreaterThan(2);
  });

  it("uses the nearest road, perpendicular, for a lone node within 3 m", () => {
    const all = rings(paint([node({ crossing: "zebra" }, [50, 102])]));
    expect(all).toHaveLength(7);
    const box = bounds(all);
    expect((box.minX + box.maxX) / 2).toBeCloseTo(50, 6);
    expect((box.minY + box.maxY) / 2).toBeCloseTo(100, 6);
    expect(box.maxY - box.minY).toBeCloseTo(6.5, 6);
  });

  it("draws nothing for a node 5 m from any road", () => {
    expect(paint([node({ crossing: "zebra" }, [50, 105])])).toEqual([]);
  });

  it("leaves a node to the crossing line within 2 m", () => {
    const all = rings(
      paint([
        line({ markings: "zebra" }, [100, 90], [100, 110]),
        node({ crossing: "zebra" }, [101, 100]),
      ]),
    );
    expect(all).toHaveLength(7);
  });

  it("takes the crossed road's layer", () => {
    const bridge = line(
      { class: "primary", lanes: 2, layer: 1, bridge: true },
      [0, 100],
      [200, 100],
    );
    expect(paint([line({ markings: "zebra" }, [100, 90], [100, 110])], [bridge])[0]?.layer).toBe(1);
  });
});
