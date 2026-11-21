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
  it("fits every glyph in 5 m × 1.2 m, centred and pointing +y", () => {
    for (const [name, glyph] of Object.entries(ARROW_GLYPHS)) {
      const all = glyph.flat();
      expect(Math.min(...all.map((p) => p[0])), name).toBeGreaterThanOrEqual(-0.6);
      expect(Math.max(...all.map((p) => p[0])), name).toBeLessThanOrEqual(0.6);
      expect(Math.min(...all.map((p) => p[1])), name).toBeGreaterThanOrEqual(-2.5);
      expect(Math.max(...all.map((p) => p[1])), name).toBeLessThanOrEqual(2.5);
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

  it("draws the union of several values and nothing for none", () => {
    expect(glyphUnion(["left", "through"])).toEqual([
      ...(ARROW_GLYPHS.left ?? []),
      ...(ARROW_GLYPHS.through ?? []),
    ]);
    expect(glyphUnion(["none"])).toEqual([]);
    expect(glyphUnion([])).toEqual([]);
    expect(glyphUnion(["unknown"])).toEqual([]);
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
