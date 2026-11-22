import { describe, expect, it } from "vitest";
import type { LngLat } from "../../types/geometry";
import { type RoundaboutStep, roundaboutGlyph, roundaboutTurnAt } from "../roundabout";

// Strausberger Platz, Berlin: in from Alexanderstraße, out at the 2nd exit
// onto Karl-Marx-Allee, as Valhalla returns it (enter, then exit roundabout).
const strausberger: RoundaboutStep[] = [
  {
    maneuver: { type: "turn", modifier: "right" },
    coordinates: [
      [13.427322, 52.518608],
      [13.427501, 52.5185],
      [13.427641, 52.518406],
    ],
  },
  {
    maneuver: { type: "roundabout" },
    bearingBefore: 137,
    bearingAfter: 146,
    coordinates: [
      [13.427641, 52.518406],
      [13.427669, 52.518381],
      [13.427859, 52.518257],
      [13.427943, 52.518217],
      [13.428045, 52.518177],
      [13.428199, 52.518149],
      [13.428345, 52.518135],
      [13.428464, 52.518134],
      [13.428576, 52.518143],
      [13.428592, 52.518146],
    ],
  },
  {
    maneuver: { type: "exit roundabout" },
    bearingBefore: 73,
    bearingAfter: 78,
    coordinates: [
      [13.428592, 52.518146],
      [13.428853, 52.518181],
      [13.429106, 52.518204],
    ],
  },
];

/** A roundabout entered heading north around a circle of `radius` m, bending as given. */
function circling(clockwise: boolean, exitTurn: number): RoundaboutStep[] {
  const M = 1 / 111_195;
  const arc: LngLat[] = [];
  for (let deg = 0; deg <= 120; deg += 15) {
    const a = (deg * Math.PI) / 180;
    const x = (clockwise ? 1 : -1) * (15 - 15 * Math.cos(a));
    arc.push([x * M, 15 * Math.sin(a) * M]);
  }
  return [
    {
      maneuver: { type: "turn" },
      coordinates: [
        [0, -30 * M],
        [0, 0],
      ],
    },
    { maneuver: { type: "roundabout" }, bearingBefore: 0, coordinates: arc },
    { maneuver: { type: "exit roundabout" }, bearingAfter: exitTurn, coordinates: [] },
  ];
}

describe("roundaboutTurnAt", () => {
  it("circles counter-clockwise where traffic drives on the right", () => {
    const turn = roundaboutTurnAt(strausberger, 1);
    expect(turn?.circulation).toBe("ccw");
    // 59° left of the way in: past the straight-on point, before the left exit.
    expect(turn?.exitAngle).toBeCloseTo(239, 0);
  });

  it("describes the exit step by the roundabout it leaves", () => {
    expect(roundaboutTurnAt(strausberger, 2)).toEqual(roundaboutTurnAt(strausberger, 1));
  });

  it("reads the circling direction from the path when the engine names no driving side", () => {
    expect(roundaboutTurnAt(circling(true, 90), 1)?.circulation).toBe("cw");
    expect(roundaboutTurnAt(circling(false, 270), 1)?.circulation).toBe("ccw");
  });

  it("follows the engine's driving side over the path", () => {
    const steps = circling(false, 270);
    steps[1] = { ...steps[1], drivingSide: "left" } as RoundaboutStep;
    expect(roundaboutTurnAt(steps, 1)?.circulation).toBe("cw");
  });

  it("measures the exit angle round the circle in the direction of travel", () => {
    // Clockwise (left-hand traffic): the left exit comes first.
    expect(roundaboutTurnAt(circling(true, 270), 1)?.exitAngle).toBeCloseTo(90, 0);
    expect(roundaboutTurnAt(circling(true, 90), 1)?.exitAngle).toBeCloseTo(270, 0);
    // Counter-clockwise: the right exit comes first, a U-turn last.
    expect(roundaboutTurnAt(circling(false, 90), 1)?.exitAngle).toBeCloseTo(90, 0);
    expect(roundaboutTurnAt(circling(false, 180), 1)?.exitAngle).toBe(360);
  });

  it("describes only roundabouts", () => {
    expect(roundaboutTurnAt(strausberger, 0)).toBeUndefined();
    expect(roundaboutTurnAt(strausberger, 9)).toBeUndefined();
  });
});

/** The arrowhead's tip: the fill's first point. */
function tip(turn: Parameters<typeof roundaboutGlyph>[0]): [number, number] {
  const [x, y] = (roundaboutGlyph(turn).fills[0] ?? "").replace(/^M\s*/, "").split(/[\s,L]+/);
  return [Number(x), Number(y)];
}

describe("roundaboutGlyph", () => {
  it("enters from below and leaves towards the exit", () => {
    const [rx, ry] = tip({ circulation: "ccw", exitAngle: 90 });
    expect(rx).toBeGreaterThan(20);
    expect(ry).toBeCloseTo(11, 0);
    const [sx, sy] = tip({ circulation: "ccw", exitAngle: 180 });
    expect(sx).toBeCloseTo(12, 0);
    expect(sy).toBeLessThan(3);
    expect(tip({ circulation: "ccw", exitAngle: 270 })[0]).toBeLessThan(4);
  });

  it("draws the way round counter-clockwise for right-hand traffic", () => {
    // The arc starts at the bottom of the circle and runs up its right side.
    const travelled = roundaboutGlyph({ circulation: "ccw", exitAngle: 180 }).strokes.at(-1)?.d;
    expect(travelled).toMatch(/A5 5 0 0 0 12 6$|A5 5 0 0 0 12 6 /);
  });

  it("mirrors the glyph for clockwise circulation", () => {
    const [lx] = tip({ circulation: "cw", exitAngle: 90 });
    expect(lx).toBeLessThan(4);
    const ccw = roundaboutGlyph({ circulation: "ccw", exitAngle: 135 });
    const cw = roundaboutGlyph({ circulation: "cw", exitAngle: 135 });
    expect(tip({ circulation: "cw", exitAngle: 135 })[0]).toBeCloseTo(
      24 - tip({ circulation: "ccw", exitAngle: 135 })[0],
      5,
    );
    expect(cw.strokes.length).toBe(ccw.strokes.length);
  });

  it("puts a U-turn's exit beside the way in rather than on it", () => {
    const [ux] = tip({ circulation: "ccw", exitAngle: 360 });
    expect(Math.abs(ux - 12)).toBeGreaterThan(1.5);
  });
});
