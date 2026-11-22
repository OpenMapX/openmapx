import { describe, expect, it } from "vitest";
import type { LngLat } from "../../types/geometry";
import {
  type RoundaboutStep,
  roundaboutGlyph,
  roundaboutRole,
  roundaboutTurnAt,
} from "../roundabout";

// Großer Stern, Berlin, as the server returned it before the exit step had its
// own name: 100 m of the road in, the way round, and 100 m of the road out.
const grosserStern: RoundaboutStep[] = [
  {
    maneuver: { type: "depart" },
    bearingAfter: 84,
    coordinates: [
      [13.347287, 52.514243],
      [13.348075, 52.514299],
      [13.348323, 52.514316],
      [13.348387, 52.51432],
      [13.348469, 52.514325],
      [13.348558, 52.514327],
      [13.348673, 52.514326],
      [13.348786, 52.51431],
      [13.348895, 52.514279],
      [13.349009, 52.514244],
      [13.349231, 52.514162],
    ],
  },
  {
    maneuver: { type: "roundabout" },
    roundaboutExitCount: 2,
    bearingBefore: 121,
    bearingAfter: 137,
    coordinates: [
      [13.349231, 52.514162],
      [13.349314, 52.514097],
      [13.34941, 52.514039],
      [13.349518, 52.513989],
      [13.349636, 52.513948],
      [13.349698, 52.513933],
      [13.349761, 52.513917],
      [13.349892, 52.513896],
      [13.350032, 52.513886],
      [13.350173, 52.513887],
      [13.350339, 52.513901],
      [13.350403, 52.513915],
      [13.350447, 52.513924],
      [13.350576, 52.513959],
      [13.350648, 52.513984],
      [13.350716, 52.514014],
      [13.35078, 52.514046],
      [13.350839, 52.514081],
      [13.350894, 52.514119],
      [13.350944, 52.51416],
      [13.350988, 52.514203],
      [13.351026, 52.514248],
    ],
  },
  {
    maneuver: { type: "roundabout" },
    bearingBefore: 34,
    bearingAfter: 49,
    coordinates: [
      [13.351026, 52.514248],
      [13.351276, 52.514378],
      [13.351439, 52.514454],
      [13.351552, 52.514496],
      [13.351707, 52.514538],
      [13.351736, 52.514543],
      [13.351808, 52.514554],
      [13.352386, 52.514591],
    ],
  },
];

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
    // Karl-Marx-Allee leaves left of the way in: past straight on, before the left exit.
    expect(turn?.exitAngle).toBeGreaterThan(200);
    expect(turn?.exitAngle).toBeLessThan(250);
  });

  it("reads the roads in and out, not the slip lanes onto the circle", () => {
    // Großer Stern, Berlin: in on Straße des 17. Juni from the west, out at the
    // 2nd exit along it to the east. The slip lanes bend to 121° in and 49° out,
    // which would read as a left exit; the roads themselves run nearly straight.
    const turn = roundaboutTurnAt(grosserStern, 1);
    expect(turn?.circulation).toBe("ccw");
    expect(turn?.exitAngle).toBeGreaterThan(180);
    expect(turn?.exitAngle).toBeLessThan(215);
  });

  it("recognises the exit step a server named as a second roundabout", () => {
    // Before Valhalla's exit was named `exit roundabout`, it came through as a
    // `roundabout` without an exit count; saved routes still carry that.
    expect(roundaboutRole(grosserStern, 1)).toBe("entry");
    expect(roundaboutRole(grosserStern, 2)).toBe("exit");
    expect(roundaboutRole(strausberger, 2)).toBe("exit");
    expect(roundaboutRole(strausberger, 0)).toBeUndefined();
    expect(roundaboutTurnAt(grosserStern, 2)).toEqual(roundaboutTurnAt(grosserStern, 1));
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
    expect(ry).toBeCloseTo(12, 0);
    const [sx, sy] = tip({ circulation: "ccw", exitAngle: 180 });
    expect(sx).toBeCloseTo(12, 0);
    expect(sy).toBeLessThan(3);
    expect(tip({ circulation: "ccw", exitAngle: 270 })[0]).toBeLessThan(4);
  });

  it("draws the way round counter-clockwise for right-hand traffic", () => {
    // The arc starts at the bottom of the circle and runs up its right side.
    const travelled = roundaboutGlyph({ circulation: "ccw", exitAngle: 180 }).strokes.at(-1)?.d;
    expect(travelled).toMatch(/A4 4 0 0 0 12 8$|A4 4 0 0 0 12 8 /);
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

  it.each([90, 180, 239, 270])("leaves the circle along a stretch of road at %d°", (exitAngle) => {
    // From where the exit leaves the circle (the dimmed rest starts there) to
    // the arrowhead's base, so the exit reads as a road and not a bare head.
    const [rest, travelled] = roundaboutGlyph({ circulation: "ccw", exitAngle }).strokes;
    const numbers = (d: string | undefined) =>
      (d ?? "").replace(/[MLA]/g, " ").trim().split(/\s+/).map(Number);
    const [ox, oy] = numbers(rest?.d);
    const [by, bx] = numbers(travelled?.d).reverse();
    expect(Math.hypot((bx ?? 0) - (ox ?? 0), (by ?? 0) - (oy ?? 0))).toBeGreaterThanOrEqual(3);
  });

  it("keeps the way in shorter than the way out", () => {
    // The stroke starts at the foot of the way in and reaches the circle at its bottom.
    const travelled =
      roundaboutGlyph({ circulation: "ccw", exitAngle: 180 }).strokes.at(-1)?.d ?? "";
    const [, , x, y] = travelled.replace(/[MLA]/g, " ").trim().split(/\s+/).map(Number);
    const [, footY] = travelled.replace(/[MLA]/g, " ").trim().split(/\s+/).map(Number);
    expect(x).toBe(12);
    expect((footY ?? 0) - (y ?? 0)).toBeLessThanOrEqual(5);
  });

  it("puts a U-turn's exit beside the way in rather than on it", () => {
    const [ux] = tip({ circulation: "ccw", exitAngle: 360 });
    expect(Math.abs(ux - 12)).toBeGreaterThan(1.5);
  });
});
