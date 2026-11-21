import { describe, expect, it } from "vitest";
import { ARROW_GLYPHS, glyphUnion, turnArrows } from "../web/derive/arrows";
import type { TileFeature } from "../web/derive/decode";
import { distanceToPolyline, type Pt, pointAlong, type Ring } from "../web/derive/geometry";
import { junctionCuts } from "../web/derive/lanes";
import { crossSection, isMotorRoad, linesInMetres, type PaintPolygon } from "../web/derive/roads";
import { metresPerUnit } from "../web/derive/units";
import { fixtureTile, streetFixture, TURN_LANES } from "./fixtures";

const MPU = 0.1;
/** A 409.6 m tile with a 3.2 m buffer, in metres. */
const BUFFERED = { min: -3.2, max: 412.8 };
type Props = Record<string, string | number | boolean>;

function road(props: Props, ...points: Pt[]): TileFeature {
  return {
    type: 2,
    geometry: [points.map(([x, y]): Pt => [x / MPU, y / MPU])],
    props: { oneway: 0, layer: 0, ...props },
  };
}

function arrows(roads: TileFeature[], buffered = BUFFERED): PaintPolygon[] {
  const sections = roads.map((r) => crossSection(r.props, false));
  return turnArrows(roads, sections, junctionCuts(roads, sections, MPU), MPU, buffered);
}

const rings = (polygons: PaintPolygon[]) => polygons.flatMap((p) => p.rings);
const centroid = (ring: Ring): Pt => [
  ring.reduce((s, p) => s + p[0], 0) / ring.length,
  ring.reduce((s, p) => s + p[1], 0) / ring.length,
];
const bounds = (ring: Ring) => ({
  minX: Math.min(...ring.map((p) => p[0])),
  maxX: Math.max(...ring.map((p) => p[0])),
  minY: Math.min(...ring.map((p) => p[1])),
  maxY: Math.max(...ring.map((p) => p[1])),
});

/** Tip x of each arrow along a west–east road: rings of one glyph lie within its 5 m. */
function tipsX(placed: Ring[]): number[] {
  const tips: number[] = [];
  for (const maxX of placed.map((ring) => bounds(ring).maxX).sort((a, b) => b - a)) {
    if (!tips.some((tip) => tip - maxX < 5)) tips.push(maxX);
  }
  return tips.map((tip) => Math.round(tip * 1000) / 1000).sort((a, b) => a - b);
}

/** A one-way approach from the west ending at a junction at (200, 100). */
const approach = (props: Props, west = 100) => [
  road({ class: "primary", oneway: 1, ...props }, [west, 100], [200, 100]),
  road({ class: "residential" }, [200, 0], [200, 100]),
  road({ class: "residential" }, [200, 100], [200, 200]),
];

describe("arrow glyphs", () => {
  it("fits every glyph in 5 m (1.2 m wide straight, 1.6 m turning), reaching the front", () => {
    for (const [name, glyph] of Object.entries(ARROW_GLYPHS)) {
      const all = glyph.flat();
      const half = name === "through" ? 0.6 : 0.8;
      expect(Math.min(...all.map((p) => p[0])), name).toBeGreaterThanOrEqual(-half - 1e-9);
      expect(Math.max(...all.map((p) => p[0])), name).toBeLessThanOrEqual(half + 1e-9);
      expect(Math.min(...all.map((p) => p[1])), name).toBeGreaterThanOrEqual(-2.5 - 1e-9);
      expect(Math.max(...all.map((p) => p[1])), name).toBeCloseTo(2.5, 9);
    }
    expect(Object.keys(ARROW_GLYPHS).sort()).toEqual(
      [
        "through",
        "left",
        "right",
        "slight_left",
        "slight_right",
        "sharp_left",
        "sharp_right",
        "reverse",
        "merge_to_left",
        "merge_to_right",
      ].sort(),
    );
  });

  it("gives every arrow a full-size head pointing where the lane turns", () => {
    /** The head is the glyph's largest triangle; its tip is the vertex farthest from the other two. */
    const triangleArea = ([a, b, c]: Pt[]) =>
      Math.abs(
        ((b as Pt)[0] - (a as Pt)[0]) * ((c as Pt)[1] - (a as Pt)[1]) -
          ((c as Pt)[0] - (a as Pt)[0]) * ((b as Pt)[1] - (a as Pt)[1]),
      ) / 2;
    const head = (name: string) => {
      const triangles = (ARROW_GLYPHS[name] ?? []).filter((ring) => ring.length === 3);
      const triangle = triangles.reduce((best, ring) =>
        triangleArea(ring) > triangleArea(best) ? ring : best,
      ) as Pt[];
      const area = triangleArea(triangle);
      const spread = (i: number) =>
        triangle
          .filter((_, j) => j !== i)
          .reduce(
            (sum, q) =>
              sum + Math.hypot(q[0] - (triangle[i] as Pt)[0], q[1] - (triangle[i] as Pt)[1]),
            0,
          );
      const tipIndex = [0, 1, 2].reduce((best, i) => (spread(i) > spread(best) ? i : best), 0);
      const tip = triangle[tipIndex] as Pt;
      const [b0, b1] = triangle.filter((_, j) => j !== tipIndex) as [Pt, Pt];
      const mid: Pt = [(b0[0] + b1[0]) / 2, (b0[1] + b1[1]) / 2];
      // Clockwise from straight ahead: negative turns left.
      const angle = (Math.atan2(tip[0] - mid[0], tip[1] - mid[1]) * 180) / Math.PI;
      return { area, angle };
    };
    for (const name of Object.keys(ARROW_GLYPHS))
      expect(head(name).area, name).toBeGreaterThanOrEqual(0.3);
    expect(head("through").angle).toBeCloseTo(0, 6);
    expect(head("slight_left").angle).toBeLessThan(-15);
    expect(head("slight_left").angle).toBeGreaterThan(-45);
    expect(head("left").angle).toBeLessThan(-50);
    expect(head("left").angle).toBeGreaterThan(-100);
    expect(head("sharp_left").angle).toBeLessThan(-110);
    expect(Math.abs(head("reverse").angle)).toBeGreaterThan(160);
    expect(head("right").angle).toBeCloseTo(-head("left").angle, 6);
    expect(head("merge_to_left").angle).toBeLessThan(-5);
  });

  it("draws the union of several values and nothing for none", () => {
    expect(glyphUnion(["left", "through"])).toEqual([
      ...(ARROW_GLYPHS.left ?? []),
      ...(ARROW_GLYPHS.through ?? []),
    ]);
    expect(glyphUnion(["none"])).toEqual([]);
    expect(glyphUnion([])).toEqual([]);
    expect(glyphUnion(["unknown"])).toEqual([]);
    // Mapped values are untrusted: never reach Object.prototype.
    expect(glyphUnion(["constructor", "__proto__", "toString", "hasOwnProperty"])).toEqual([]);
  });
});

describe("turn arrows", () => {
  it("places arrows 4 m and 24 m before the stop line, in each lane", () => {
    const polygons = arrows(approach({ lanes: 2, turn: "left|through" }));
    expect(polygons.every((p) => p.kind === "arrow")).toBe(true);
    const placed = rings(polygons);
    // Stop line: the side streets' half-width 2.75 m + 1 m before x = 200.
    const stop = 200 - 3.75;
    expect(tipsX(placed)).toEqual([stop - 24, stop - 4]);
    const lanesY = [...new Set(placed.map((ring) => Math.round(centroid(ring)[1] * 100) / 100))];
    expect(lanesY.length).toBeGreaterThanOrEqual(2);
    for (const ring of placed) {
      const { minY, maxY } = bounds(ring);
      expect(minY).toBeGreaterThanOrEqual(100 - 3.25 - 1e-9);
      expect(maxY).toBeLessThanOrEqual(100 + 3.25 + 1e-9);
    }
  });

  it("omits the second arrow when less than 34 m remain", () => {
    const placed = rings(arrows(approach({ lanes: 1, turn: "through" }, 170)));
    expect(tipsX(placed)).toEqual([200 - 3.75 - 4]);
  });

  it("draws nothing for none, empty lanes or a list of the wrong length", () => {
    expect(rings(arrows(approach({ lanes: 2, turn: "none|" })))).toEqual([]);
    expect(rings(arrows(approach({ lanes: 3, turn: "left|through" })))).toEqual([]);
  });

  it("draws no arrows at an end on the buffer boundary", () => {
    const roads = [
      road({ class: "primary", oneway: 1, lanes: 1, turn: "through" }, [100, 100], [412.8, 100]),
    ];
    expect(rings(arrows(roads))).toEqual([]);
  });

  it("anchors at a real end inside the buffer but outside the tile square", () => {
    const roads = [
      road({ class: "primary", oneway: 1, lanes: 1, turn: "through" }, [300, 100], [411, 100]),
    ];
    const placed = rings(arrows(roads));
    expect(placed.length).toBeGreaterThan(0);
    expect(placed.some((ring) => ring.some(([x]) => x < 409.6))).toBe(true);
  });

  it("anchors backward lanes at the start of the line, pointing back", () => {
    const roads = [
      road({ class: "residential" }, [100, 0], [100, 100]),
      road({ class: "residential" }, [100, 100], [100, 200]),
      road(
        { class: "primary", lanes_fw: 1, lanes_bw: 1, turn_bw: "through" },
        [100, 100],
        [200, 100],
      ),
    ];
    const placed = rings(arrows(roads));
    expect(placed.length).toBeGreaterThan(0);
    const stop = 100 + 3.75;
    const tips = placed.map((ring) => bounds(ring).minX);
    expect(Math.min(...tips)).toBeCloseTo(stop + 4, 6);
    // Backward lanes run on the north side (y < 100) in right-hand traffic.
    for (const ring of placed) expect(centroid(ring)[1]).toBeLessThan(100);
  });

  it("follows a reversed one-way road's travel direction", () => {
    const roads = [
      road({ class: "residential" }, [200, 0], [200, 100]),
      road({ class: "residential" }, [200, 100], [200, 200]),
      road({ class: "primary", oneway: -1, lanes: 1, turn: "through" }, [200, 100], [100, 100]),
    ];
    const placed = rings(arrows(roads));
    expect(Math.max(...placed.map((ring) => bounds(ring).maxX))).toBeCloseTo(200 - 3.75 - 4, 6);
  });
});

describe("turn lanes fixture", () => {
  it("draws arrows inside mapped lanes and keeps them out of junctions", () => {
    const tile = streetFixture(TURN_LANES);
    const { z, y } = fixtureTile(TURN_LANES);
    const mpu = metresPerUnit(z, y, tile.extent);
    const roads = (tile.layers.roads ?? []).filter((r) => isMotorRoad(r.props));
    const sections = roads.map((r) => crossSection(r.props, false));
    const cuts = junctionCuts(roads, sections, mpu);
    const size = tile.extent * mpu;
    const buffered = { min: -32 * (size / 256), max: size + 32 * (size / 256) };
    let drawn = 0;
    roads.forEach((r, i) => {
      const section = sections[i];
      if (!section) return;
      const own = rings(turnArrows([r], [section], [cuts[i] ?? []], mpu, buffered));
      drawn += own.length;
      const lines = linesInMetres(r, mpu);
      for (const ring of own) {
        const d = Math.min(...lines.map((line) => distanceToPolyline(centroid(ring), line).d));
        expect(d).toBeLessThanOrEqual(section.width / 2);
      }
      // Arrows stay before the stop line: at least 4 m from every junction vertex of this road.
      for (const piece of cuts[i] ?? []) {
        if (!piece.endAtJunction) continue;
        const vertex = pointAlong(piece.line, piece.endVertexM).point;
        for (const ring of own)
          expect(
            Math.hypot(centroid(ring)[0] - vertex[0], centroid(ring)[1] - vertex[1]),
          ).toBeGreaterThan(4);
      }
    });
    expect(drawn).toBeGreaterThan(0);
  });
});
