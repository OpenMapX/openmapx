import { describe, expect, it } from "vitest";
import type { TileFeature } from "../web/derive/decode";
import type { Pt, Ring } from "../web/derive/geometry";
import {
  basketballLines,
  PITCH_TEMPLATES,
  pitchPaint,
  soccerLines,
  tennisLayout,
} from "../web/derive/pitches";
import { metresPerUnit } from "../web/derive/units";
import { fixtureTile, PITCH_EAST, PITCH_WEST, streetFixture } from "./fixtures";

const MPU = 0.1;

const polygon = (sport: string, ring: Pt[]): TileFeature => ({
  type: 3,
  geometry: [ring.map(([x, y]): Pt => [x / MPU, y / MPU])],
  props: { sport },
});
/** A rectangle `length` along x and `width` along y, with an optional notch into its top side. */
function rectangle(length: number, width: number, notch?: [number, number]): Pt[] {
  const [x0, y0] = [100, 100];
  if (!notch)
    return [
      [x0, y0],
      [x0 + length, y0],
      [x0 + length, y0 + width],
      [x0, y0 + width],
    ];
  const [w, d] = notch;
  const mid = x0 + length / 2;
  return [
    [x0, y0],
    [mid - w / 2, y0],
    [mid - w / 2, y0 + d],
    [mid + w / 2, y0 + d],
    [mid + w / 2, y0],
    [x0 + length, y0],
    [x0 + length, y0 + width],
    [x0, y0 + width],
  ];
}
const bounds = (rings: Ring[]) => {
  const points = rings.flat();
  return {
    minX: Math.min(...points.map((p) => p[0])),
    maxX: Math.max(...points.map((p) => p[0])),
    minY: Math.min(...points.map((p) => p[1])),
    maxY: Math.max(...points.map((p) => p[1])),
  };
};
const closeTo = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected)).toBeLessThan(1e-6);

describe("pitch fitting", () => {
  it("rejects a pitch filling less than 85 % of its rectangle and accepts more", () => {
    // 50 × 30 = 1500 m²; a 24 × 10 notch leaves 84 %, a 21 × 10 notch 86 %.
    expect(pitchPaint([polygon("soccer", rectangle(50, 30, [24, 10]))], MPU)).toEqual([]);
    expect(pitchPaint([polygon("soccer", rectangle(50, 30, [21, 10]))], MPU)).not.toEqual([]);
  });

  it("rejects a short side under 10 m", () => {
    expect(pitchPaint([polygon("soccer", rectangle(30, 9))], MPU)).toEqual([]);
  });
});

describe("football", () => {
  it("draws the IFAB markings at full size on a 105 × 68 pitch", () => {
    const lines = soccerLines(105, 68);
    const penalty = bounds(lines.penaltyAreas.slice(0, 1));
    closeTo(penalty.maxX - penalty.minX, 40.32);
    closeTo(penalty.maxY - penalty.minY, 16.5);
    const goal = bounds(lines.goalAreas.slice(0, 1));
    closeTo(goal.maxX - goal.minX, 18.32);
    closeTo(goal.maxY - goal.minY, 5.5);
    const circle = bounds(lines.centreCircle);
    closeTo(circle.maxX - circle.minX, 2 * 9.15);
    const marks = lines.penaltyMarks.map((ring) => bounds([ring]));
    expect(
      marks.map((m) => Math.round(((m.minY + m.maxY) / 2) * 1000) / 1000).sort((a, b) => a - b),
    ).toEqual([-(52.5 - 11), 52.5 - 11]);
    const boundary = bounds(lines.boundary);
    closeTo(boundary.maxX - boundary.minX, 68);
    closeTo(boundary.maxY - boundary.minY, 105);
    expect(lines.cornerArcs).toHaveLength(4);
  });

  it("scales the fixed distances by length / 105 on a smaller pitch", () => {
    const lines = soccerLines(60, 40);
    const s = 60 / 105;
    const penalty = bounds(lines.penaltyAreas.slice(0, 1));
    closeTo(penalty.maxX - penalty.minX, 40.32 * s);
    closeTo(penalty.maxY - penalty.minY, 16.5 * s);
    closeTo(bounds(lines.centreCircle).maxX, 9.15 * s);
    const boundary = bounds(lines.boundary);
    closeTo(boundary.maxX - boundary.minX, 40);
    closeTo(boundary.maxY - boundary.minY, 60);
  });

  it("uses the first sport of a list", () => {
    const soccer = pitchPaint([polygon("soccer;basketball", rectangle(60, 40))], MPU);
    const plain = pitchPaint([polygon("soccer", rectangle(60, 40))], MPU);
    expect(soccer).toEqual(plain);
  });
});

describe("tennis", () => {
  it("fits one regulation court or several side by side with 4 m gaps", () => {
    expect(tennisLayout(23.77, 10.97)).toEqual([0]);
    expect(tennisLayout(30, 18)).toEqual([0]);
    const two = tennisLayout(40, 36);
    expect(two).toHaveLength(2);
    closeTo((two?.[1] ?? 0) - (two?.[0] ?? 0), 10.97 + 4);
    closeTo((two?.[0] ?? 0) + (two?.[1] ?? 0), 0);
    expect(tennisLayout(20, 12)).toBeNull();
    expect(tennisLayout(25, 9)).toBeNull();
  });

  it("draws the court at 23.77 × 10.97 m with singles lines 8.23 m apart", () => {
    const court = bounds(PITCH_TEMPLATES.tennis);
    closeTo(court.maxY - court.minY, 23.77 + 0.1);
    closeTo(court.maxX - court.minX, 10.97 + 0.1);
  });
});

describe("basketball", () => {
  it("scales the court down to fit", () => {
    const lines = basketballLines(20, 12);
    const all = bounds(lines);
    expect(all.maxX - all.minX).toBeLessThanOrEqual(12 + 1e-6);
    expect(all.maxY - all.minY).toBeLessThanOrEqual(20 + 1e-6);
    const full = bounds(basketballLines(40, 30));
    closeTo(full.maxX - full.minX, 15);
    closeTo(full.maxY - full.minY, 28);
  });
});

describe("other sports", () => {
  it("draws the boundary inset 1 m", () => {
    const [paint] = pitchPaint([polygon("volleyball", rectangle(20, 12))], MPU);
    expect(paint?.kind).toBe("pitch");
    const box = bounds(paint?.rings ?? []);
    closeTo(box.maxX - box.minX, 18 + 0.1);
    closeTo(box.maxY - box.minY, 10 + 0.1);
  });
});

describe("straddling pitch fixtures", () => {
  it("draws the same markings in both tiles", () => {
    const toWorld = (name: string) => {
      const tile = streetFixture(name);
      const { z, x, y } = fixtureTile(name);
      const mpu = metresPerUnit(z, y, tile.extent);
      const shift = x * tile.extent * mpu;
      return pitchPaint(tile.layers.pitches ?? [], mpu).map((paint) =>
        paint.rings.map((ring) => ring.map(([px, py]): Pt => [px + shift, py])),
      );
    };
    const centre = (rings: Ring[]): Pt => {
      const box = bounds(rings);
      return [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2];
    };
    const west = toWorld(PITCH_WEST);
    const east = toWorld(PITCH_EAST);
    let shared = 0;
    for (const a of west) {
      const ca = centre(a);
      const b = east.find((rings) => {
        const cb = centre(rings);
        return Math.hypot(cb[0] - ca[0], cb[1] - ca[1]) < 1;
      });
      if (!b) continue;
      shared++;
      expect(b).toHaveLength(a.length);
      for (const [i, ring] of a.entries()) {
        for (const [j, p] of ring.entries()) {
          const q = b[i]?.[j] as Pt;
          expect(Math.hypot(q[0] - p[0], q[1] - p[1])).toBeLessThan(0.01);
        }
      }
    }
    expect(shared).toBeGreaterThan(0);
  });
});
