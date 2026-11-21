import { describe, expect, it } from "vitest";
import type { TileFeature } from "../web/derive/decode";
import { type Pt, type Ring, ringArea } from "../web/derive/geometry";
import { railPaint } from "../web/derive/rails";
import type { PaintPolygon } from "../web/derive/roads";
import { metresPerUnit } from "../web/derive/units";
import { fixtureTile, streetFixture, TRAM } from "./fixtures";

const MPU = 0.1;
type Props = Record<string, string | number | boolean>;

const line = (props: Props, ...points: Pt[]): TileFeature => ({
  type: 2,
  geometry: [points.map(([x, y]): Pt => [x / MPU, y / MPU])],
  props,
});
const area = (rings: Ring[]) => rings.reduce((s, r) => s + Math.abs(ringArea(r)), 0);
const ofKind = (polygons: PaintPolygon[], kind: string) =>
  polygons.filter((p) => p.kind === kind).flatMap((p) => p.rings);
const ys = (rings: Ring[]) =>
  [...new Set(rings.map((r) => Math.round((r.reduce((s, p) => s + p[1], 0) / r.length) * 10000)))]
    .map((v) => v / 10000)
    .sort((a, b) => a - b);

describe("rails", () => {
  it("draws two 0.1 m rails at standard gauge on a 2.6 m band", () => {
    const polygons = railPaint([line({ kind: "rail", layer: 0 }, [0, 50], [100, 50])], [], MPU);
    const rails = ofKind(polygons, "rail");
    expect(area(rails)).toBeCloseTo(2 * 100 * 0.1, 6);
    expect(ys(rails)).toEqual([50 - 1.435 / 2, 50 + 1.435 / 2]);
    expect(area(ofKind(polygons, "rail_band"))).toBeCloseTo(100 * 2.6, 6);
  });

  it("uses a metre gauge for narrow gauge", () => {
    const rails = ofKind(
      railPaint([line({ kind: "narrow_gauge" }, [0, 50], [100, 50])], [], MPU),
      "rail",
    );
    expect(ys(rails)).toEqual([49.5, 50.5]);
  });

  it("draws only the rails of embedded tram tracks", () => {
    const polygons = railPaint(
      [line({ kind: "tram", embedded: "yes" }, [0, 50], [100, 50])],
      [],
      MPU,
    );
    expect(ofKind(polygons, "rail_band")).toEqual([]);
    expect(ofKind(polygons, "rail")).not.toEqual([]);
  });

  it("keeps a rail bridge's layer so it sorts above the street below", () => {
    const polygons = railPaint(
      [line({ kind: "rail", layer: 1, bridge: true }, [0, 50], [100, 50])],
      [],
      MPU,
    );
    expect(polygons.every((p) => p.layer === 1)).toBe(true);
  });
});

describe("bridge paths", () => {
  it("draws a 3 m surface with a 0.3 m edge on each side", () => {
    const polygons = railPaint(
      [],
      [line({ class: "footway", bridge: true, layer: 1 }, [0, 50], [100, 50])],
      MPU,
    );
    expect(area(ofKind(polygons, "path_bridge"))).toBeCloseTo(300, 6);
    const edges = ofKind(polygons, "path_bridge_edge");
    expect(area(edges)).toBeCloseTo(2 * 100 * 0.3, 6);
    expect(ys(edges)).toEqual([50 - 1.65, 50 + 1.65]);
    expect(polygons.every((p) => p.layer === 1)).toBe(true);
  });

  it("ignores motor roads and paths without a bridge", () => {
    expect(
      railPaint(
        [],
        [
          line({ class: "primary", bridge: true }, [0, 0], [10, 0]),
          line({ class: "footway", bridge: false }, [0, 0], [10, 0]),
        ],
        MPU,
      ),
    ).toEqual([]);
  });
});

describe("tram fixture", () => {
  it("draws embedded and separate tram tracks", () => {
    const tile = streetFixture(TRAM);
    const { z, y } = fixtureTile(TRAM);
    const polygons = railPaint(
      tile.layers.rails ?? [],
      tile.layers.roads ?? [],
      metresPerUnit(z, y, tile.extent),
    );
    expect(ofKind(polygons, "rail").length).toBeGreaterThan(10);
  });
});
