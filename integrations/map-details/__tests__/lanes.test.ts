import { describe, expect, it } from "vitest";
import type { TileFeature } from "../web/derive/decode";
import { distanceToPolyline, type Pt, polylineLength, ringArea } from "../web/derive/geometry";
import { junctionCuts, lanePaint } from "../web/derive/lanes";
import { crossSection, isMotorRoad, linesInMetres, type PaintPolygon } from "../web/derive/roads";
import { metresPerUnit } from "../web/derive/units";
import { ALEXANDERPLATZ, fixtureTile, streetFixture } from "./fixtures";

const MPU = 0.1;
type Props = Record<string, string | number | boolean>;

function road(props: Props, ...points: Pt[]): TileFeature {
  return {
    type: 2,
    geometry: [points.map(([x, y]): Pt => [x / MPU, y / MPU])],
    props: { oneway: 0, layer: 0, ...props },
  };
}

function paint(roads: TileFeature[], leftHand = false): PaintPolygon[] {
  const sections = roads.map((r) => crossSection(r.props, leftHand));
  return lanePaint(roads, sections, junctionCuts(roads, sections, MPU), MPU);
}

const centroid = (ring: Pt[]): Pt => [
  ring.reduce((s, p) => s + p[0], 0) / ring.length,
  ring.reduce((s, p) => s + p[1], 0) / ring.length,
];
const markings = (polygons: PaintPolygon[]) => polygons.filter((p) => p.kind === "marking");
/** Marking pieces whose centroid lies at a lateral offset (y) from a west–east road at y = 50. */
const markingPiecesAt = (polygons: PaintPolygon[], y: number) =>
  markings(polygons)
    .flatMap((p) => p.rings)
    .filter((ring) => Math.abs(centroid(ring)[1] - y) < 0.01);
const area = (rings: Pt[][]) => rings.reduce((s, r) => s + Math.abs(ringArea(r)), 0);

describe("lane strips", () => {
  it("spans the bus lane across its width and length", () => {
    const polygons = paint([
      road({ class: "primary", oneway: 1, lanes: 2, bus_lanes: "|designated" }, [0, 50], [100, 50]),
    ]);
    const bus = polygons.filter((p) => p.kind === "bus");
    expect(bus).toHaveLength(1);
    // Lanes 3.25 m each; the bus lane is the right one, centred 1.625 m right (south) of the line.
    const rings = bus[0]?.rings ?? [];
    expect(area(rings)).toBeCloseTo(100 * 3.25, 3);
    for (const ring of rings) {
      for (const [, y] of ring) {
        expect(y).toBeGreaterThanOrEqual(50 - 1e-9);
        expect(y).toBeLessThanOrEqual(53.25 + 1e-9);
      }
    }
  });

  it("paints cycle lanes green-kind strips with an edge line", () => {
    const polygons = paint([road({ class: "residential", cycle_r: "lane" }, [0, 50], [100, 50])]);
    expect(polygons.filter((p) => p.kind === "cycle")).toHaveLength(1);
    // Residential lanes are not marked, but every cycle lane has its edge line (dashed by default).
    const edge = markingPiecesAt(polygons, 50 + 2 * 2.75 - (2.75 * 2 + 1.5) / 2);
    expect(edge.length).toBeGreaterThan(5);
  });

  it("draws a solid edge line for an exclusive cycle lane", () => {
    const polygons = paint([
      road(
        { class: "residential", cycle_r: "lane", cycle_lane_r: "exclusive" },
        [0, 50],
        [100, 50],
      ),
    ]);
    const edge = markingPiecesAt(polygons, 50 + 2 * 2.75 - (2.75 * 2 + 1.5) / 2);
    expect(area(edge)).toBeCloseTo(100 * 0.15, 3);
  });
});

describe("lane dividers", () => {
  it("draws none when lanes are not marked", () => {
    expect(markings(paint([road({ class: "primary" }, [0, 50], [100, 50])]))).toEqual([]);
  });

  it("dashes same-direction dividers 3 m on, 6 m off, 0.15 m wide", () => {
    const polygons = paint([road({ class: "primary", oneway: 1, lanes: 2 }, [0, 50], [99, 50])]);
    const pieces = markingPiecesAt(polygons, 50);
    expect(pieces).toHaveLength(11);
    expect(area(pieces)).toBeCloseTo(11 * 3 * 0.15, 3);
  });

  it("dashes motorway dividers 6 m on, 12 m off", () => {
    const polygons = paint([road({ class: "motorway", oneway: 1, lanes: 2 }, [0, 50], [90, 50])]);
    expect(markingPiecesAt(polygons, 50)).toHaveLength(5);
  });

  it("separates directions with a dashed line on a two-lane road", () => {
    const polygons = paint([road({ class: "primary", lanes: 2 }, [0, 50], [99, 50])]);
    expect(markingPiecesAt(polygons, 50)).toHaveLength(11);
  });

  it("separates directions with a solid line from four lanes", () => {
    const polygons = paint([road({ class: "primary", lanes: 4 }, [0, 50], [100, 50])]);
    const centre = markingPiecesAt(polygons, 50);
    expect(area(centre)).toBeCloseTo(100 * 0.15, 3);
  });
});

describe("junction trimming", () => {
  const minDistance = (polygons: PaintPolygon[], p: Pt) =>
    Math.min(
      ...polygons
        .filter((poly) => poly.kind !== "surface")
        .flatMap((poly) => poly.rings.flat())
        .map(([x, y]) => Math.hypot(x - p[0], y - p[1])),
    );

  it("keeps lane paint out of a four-way junction", () => {
    const major = { class: "primary", lanes: 4, busway_r: "lane", cycle_both: "lane" };
    const minor = { class: "secondary", lanes: 2, cycle_both: "lane" };
    const polygons = paint([
      road(major, [0, 100], [100, 100]),
      road(major, [100, 100], [200, 100]),
      road(minor, [100, 0], [100, 100]),
      road(minor, [100, 100], [100, 200]),
    ]);
    // Largest half-width meeting there: the major road, 4 × 3.25 + 2 × 1.5 = 16 m → 8 m, plus 1 m.
    expect(minDistance(polygons, [100, 100])).toBeGreaterThanOrEqual(9 - 1e-6);
    expect(polygons.some((p) => p.kind === "bus")).toBe(true);
  });

  it("cuts a road at an interior vertex where a side street ends (T junction)", () => {
    const polygons = paint([
      road({ class: "primary", lanes: 4 }, [0, 100], [100, 100], [200, 100]),
      road({ class: "residential", lanes: 2, lane_markings: "yes" }, [100, 100], [100, 200]),
    ]);
    // The side street's half-width is 2.75 m, so the main road's paint stops 3.75 m short.
    const near = markings(polygons)
      .flatMap((p) => p.rings.flat())
      .filter(([x, y]) => Math.abs(y - 100) < 4 && Math.abs(x - 100) < 3.75 - 1e-6);
    expect(near).toEqual([]);
    // The side street's paint stops 7.5 m (main half-width 6.5 + 1) from the vertex.
    const side = markings(polygons)
      .flatMap((p) => p.rings.flat())
      .filter(([x, y]) => Math.abs(x - 100) < 3 && y > 100 && y < 107.5 - 1e-6);
    expect(side).toEqual([]);
  });

  it("does not treat a vertex shared with a road on another layer as a junction", () => {
    const sections = [
      road({ class: "primary", lanes: 2 }, [0, 100], [100, 100], [200, 100]),
      road(
        { class: "primary", lanes: 2, layer: 1, bridge: true },
        [100, 0],
        [100, 100],
        [100, 200],
      ),
    ];
    const cuts = junctionCuts(
      sections,
      sections.map((r) => crossSection(r.props, false)),
      MPU,
    );
    expect(cuts[0]).toHaveLength(1);
    expect(cuts[0]?.[0]).toMatchObject({ startM: 0, endM: 200 });
  });
});

describe("Alexanderplatz fixture", () => {
  it("produces valid paint that stays on its road", () => {
    const tile = streetFixture(ALEXANDERPLATZ);
    const { z, y } = fixtureTile(ALEXANDERPLATZ);
    const mpu = metresPerUnit(z, y, tile.extent);
    const roads = (tile.layers.roads ?? []).filter((r) => isMotorRoad(r.props));
    const sections = roads.map((r) => crossSection(r.props, false));
    const cuts = junctionCuts(roads, sections, mpu);
    const polygons = lanePaint(roads, sections, cuts, mpu);
    expect(polygons.length).toBeGreaterThan(0);
    for (const polygon of polygons) {
      for (const ring of polygon.rings) {
        expect(ring.length).toBeGreaterThanOrEqual(3);
        expect(Math.abs(ringArea(ring))).toBeGreaterThan(0);
        for (const [x, yy] of ring) expect(Number.isFinite(x) && Number.isFinite(yy)).toBe(true);
      }
    }
    // Every piece of paint lies within its road's half-width of the road's centreline.
    roads.forEach((r, i) => {
      const section = sections[i];
      if (!section) return;
      const lines = linesInMetres(r, mpu);
      const own = lanePaint([r], [section], [cuts[i] ?? []], mpu);
      for (const point of own.flatMap((p) => p.rings.flat())) {
        const d = Math.min(...lines.map((line) => distanceToPolyline(point, line).d));
        expect(d).toBeLessThanOrEqual(section.width / 2 + 0.2);
      }
      expect(lines.every((line) => polylineLength(line) >= 0)).toBe(true);
    });
  });
});
