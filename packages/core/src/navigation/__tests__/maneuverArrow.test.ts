import { assert, describe, expect, it } from "vitest";
import type { LngLat } from "../../types/geometry";
import { haversineDistance } from "../../utils/coordinates";
import { bearingBetween } from "../bearing";
import { cumulativeDistances, distanceAtVertex, positionAt } from "../deadReckon";
import {
  laneRejoinAlong,
  laneShiftedArrowLine,
  maneuverArrowLine,
  maneuverArrowTipBearing,
  raisedArrowPolygon,
  smoothArrowLine,
} from "../maneuverArrow";

// ~1.1 km straight east, so every distance check is against a known geometry.
const geometry: LngLat[] = [
  [0, 0],
  [0.01, 0],
];
const cum = cumulativeDistances(geometry);
const alongMeters = 550;

/** The arrow line, failing the test when the route was too short to carry one. */
function arrowLine(
  route: LngLat[],
  distances: number[],
  along: number,
): { line: LngLat[]; first: LngLat; last: LngLat } {
  const line = maneuverArrowLine(route, distances, along, { before: 60, after: 40 });
  assert.isNotNull(line);
  const [first] = line;
  const last = line.at(-1);
  assert.isDefined(first);
  assert.isDefined(last);
  return { line, first, last };
}

describe("maneuverArrowLine", () => {
  it("starts before and ends after the maneuver point by the requested spans", () => {
    const { first, last } = arrowLine(geometry, cum, alongMeters);
    expect(haversineDistance(first, positionAt(geometry, cum, 490).point)).toBeLessThan(1.1);
    expect(haversineDistance(last, positionAt(geometry, cum, 590).point)).toBeLessThan(1.1);
  });

  it("carries the tip bearing of the last segment", () => {
    const { line } = arrowLine(geometry, cum, alongMeters);
    // Straight east; the tip bearing is 90 within the polyline's own precision.
    expect(maneuverArrowTipBearing(line)).toBeCloseTo(90, 1);
  });

  it("keeps every route vertex between the two ends, including the first interior one", () => {
    // Vertices every ~55 m; the window 490–590 m must contain the vertices at
    // ~500 and ~555 m and nothing outside it.
    const dense: LngLat[] = Array.from({ length: 21 }, (_, i) => [i * 0.0005, 0]);
    const denseCum = cumulativeDistances(dense);
    const interior = arrowLine(dense, denseCum, alongMeters).line.slice(1, -1);
    expect(interior).toEqual(
      dense.filter(
        (_, i) => distanceAtVertex(denseCum, i) > 490 && distanceAtVertex(denseCum, i) < 590,
      ),
    );
    expect(interior.length).toBe(2);
  });

  it("clamps the spans to the route ends", () => {
    expect(arrowLine(geometry, cum, 5).first).toEqual(geometry[0]);
  });

  it("returns null when the route is shorter than the minimum", () => {
    const tiny: LngLat[] = [
      [0, 0],
      [0.00005, 0],
    ];
    expect(maneuverArrowLine(tiny, cumulativeDistances(tiny), 3, { before: 60, after: 40 })).toBe(
      null,
    );
  });
});

describe("raisedArrowPolygon", () => {
  // 60 m straight east at the equator, where 1 m of longitude is 1/111_195°.
  const M = 1 / 111_195;
  const line: LngLat[] = [
    [0, 0],
    [30 * M, 0],
    [60 * M, 0],
  ];
  const widthAt = (ring: LngLat[], eastMetres: number) => {
    const ys = ring.filter(([x]) => Math.abs(x / M - eastMetres) < 0.01).map(([, y]) => y / M);
    return Math.max(...ys) - Math.min(...ys);
  };

  it("raisedArrowPolygon is closed and as wide as asked", () => {
    const ring = raisedArrowPolygon(line, 2.4, 5);
    expect(ring[0]).toEqual(ring.at(-1));
    // The shaft keeps its width along the line, and the head is twice as wide.
    expect(widthAt(ring, 30)).toBeCloseTo(2.4, 2);
    expect(widthAt(ring, 55)).toBeCloseTo(4.8, 2);
    // The tip is the line's end.
    expect(ring.some(([x, y]) => Math.abs(x / M - 60) < 1e-6 && Math.abs(y) < 1e-9)).toBe(true);
  });

  it("returns nothing for a line too short to carry a head", () => {
    expect(
      raisedArrowPolygon(
        [
          [0, 0],
          [3 * M, 0],
        ],
        2.4,
        5,
      ),
    ).toEqual([]);
  });
});

describe("laneShiftedArrowLine", () => {
  // Eastbound along the equator, a vertex every 10 m from 0 to 60 m.
  const M_PER_DEG = 111_195.08;
  const east = (m: number): LngLat => [m / M_PER_DEG, 0];
  const line = [0, 10, 20, 30, 40, 50, 60].map(east);
  const southOf = (p: LngLat) => -p[1] * M_PER_DEG;
  const shift = { fromAlong: -100, toAlong: 30, rejoinAlong: 40, offsetMeters: 3 };

  it("runs in the lane before the junction, positive offsets to the right", () => {
    const shifted = laneShiftedArrowLine(line, 0, shift);
    expect(southOf(shifted[0] as LngLat)).toBeCloseTo(3, 1);
    expect(southOf(shifted[2] as LngLat)).toBeCloseTo(3, 1);
  });

  it("tapers back to the route line by the rejoin point and follows it after", () => {
    const shifted = laneShiftedArrowLine(line, 0, { ...shift, toAlong: 20 });
    expect(southOf(shifted[3] as LngLat)).toBeCloseTo(1.5, 1);
    expect(southOf(shifted[4] as LngLat)).toBeCloseTo(0, 3);
    expect(shifted.at(-1)).toEqual(east(60));
  });

  it("adds vertices where the taper starts and ends", () => {
    const shifted = laneShiftedArrowLine(line, 5, {
      fromAlong: -100,
      toAlong: 27,
      rejoinAlong: 33,
      offsetMeters: -2,
    });
    expect(shifted.length).toBe(line.length + 2);
    // A negative offset lies to the left: north when heading east.
    expect(southOf(shifted[0] as LngLat)).toBeCloseTo(-2, 1);
  });

  it("returns the line unchanged without an offset", () => {
    expect(laneShiftedArrowLine(line, 0, { ...shift, offsetMeters: 0 })).toEqual(line);
  });

  it("rejoins the route line just before the arrow head", () => {
    expect(laneRejoinAlong(500, "driving")).toBe(535);
    expect(laneRejoinAlong(500, "walking")).toBe(515);
  });

  it("eases into the lane where the highlight begins, like the car", () => {
    const shifted = laneShiftedArrowLine(line, 0, {
      fromAlong: 0,
      toAlong: 40,
      rejoinAlong: 50,
      offsetMeters: 3,
    });
    expect(southOf(shifted[0] as LngLat)).toBeCloseTo(0, 3);
    expect(southOf(shifted[1] as LngLat)).toBeCloseTo(2, 1);
  });
});

/** Segment pairs of a closed ring that cross; MapLibre fills a crossed outline wrongly. */
function crossings(ring: LngLat[]): string[] {
  const turn = (p: LngLat, q: LngLat, r: LngLat) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const cross = (a: LngLat, b: LngLat, c: LngLat, d: LngLat) =>
    turn(a, b, c) * turn(a, b, d) < 0 && turn(c, d, a) * turn(c, d, b) < 0;
  const found: string[] = [];
  const last = ring.length - 1;
  for (let i = 0; i < last; i++) {
    for (let j = i + 2; j < last; j++) {
      if (i === 0 && j === last - 1) continue;
      const [a, b, c, d] = [ring[i], ring[i + 1], ring[j], ring[j + 1]];
      if (a && b && c && d && cross(a, b, c, d)) found.push(`${i}×${j}`);
    }
  }
  return found;
}

describe("the raised arrow outline never crosses itself", () => {
  // The arrow through the left turn from Tegeler Weg into Osnabrücker Straße
  // (Berlin), 60 m before to 40 m after the turn, as the route draws it.
  const turnLine: LngLat[] = [
    [13.297070270718567, 52.52693227590035],
    [13.297163, 52.526656],
    [13.29717, 52.526633],
    [13.297183, 52.526592],
    [13.29719, 52.526569],
    [13.297219, 52.526475],
    [13.297398, 52.526495],
    [13.297502, 52.526505],
    [13.297562, 52.526506],
    [13.297632, 52.526501],
    [13.297917648008292, 52.52645817557771],
  ];
  const turnAlong = 60;

  it.each([-1.5, -3, -6, -8, -10])("in the left lane %d m off the route line", (offset) => {
    const shifted = laneShiftedArrowLine(turnLine, 0, {
      fromAlong: 0,
      toAlong: turnAlong,
      rejoinAlong: laneRejoinAlong(turnAlong, "driving"),
      offsetMeters: offset,
    });
    const ring = raisedArrowPolygon(shifted, 2.4, 5);
    expect(ring.length).toBeGreaterThan(4);
    expect(crossings(ring)).toEqual([]);
    // The layer smooths the line first; that must not tangle the outline either.
    expect(crossings(raisedArrowPolygon(smoothArrowLine(shifted), 2.4, 5))).toEqual([]);
  });

  const M = 1 / 111_195;
  it("inside a corner sharper than the lane is far from the route line", () => {
    // A real left turn (metres from the tip): the 10 m lane offset reaches
    // back past the short segment before the corner.
    const sharp = (
      [
        [-41.3, 76.2],
        [-43.8, 43.1],
        [-43.9, 38.6],
        [-44.0, 33.6],
        [-44.2, 29.3],
        [-35.0, 22.5],
        [-28.5, 18.3],
        [-24.1, 15.5],
        [-1.3, 0.8],
        [0, 0],
      ] as const
    ).map(([x, y]): LngLat => [x * M, y * M]);
    const shifted = laneShiftedArrowLine(sharp, 0, {
      fromAlong: 0,
      toAlong: 54,
      rejoinAlong: 89,
      offsetMeters: -10,
    });
    expect(crossings(raisedArrowPolygon(shifted, 2.4, 5))).toEqual([]);
  });

  it("when a vertex sits a hair before the base of the head", () => {
    const ring = raisedArrowPolygon(
      [
        [0, 0],
        [0, 30 * M],
        [20 * M, 35 * M],
        [(25 - 0.001) * M, 35 * M],
        [30 * M, 35 * M],
      ],
      2.4,
      5,
    );
    expect(crossings(ring)).toEqual([]);
  });

  it("around a right-angle corner drawn with many short segments", () => {
    const corner: LngLat[] = [[0, -40 * M]];
    for (let deg = 0; deg <= 90; deg += 10) {
      const a = (deg * Math.PI) / 180;
      corner.push([(1.5 - 1.5 * Math.cos(a)) * M, 1.5 * Math.sin(a) * M]);
    }
    corner.push([40 * M, 1.5 * M]);
    expect(crossings(raisedArrowPolygon(corner, 2.4, 5))).toEqual([]);
  });

  /** North 40 m, round a half circle `apart` m across to the east (left: west), south 30 m. */
  const uTurn = (apart: number, side: 1 | -1 = 1): LngLat[] => {
    const line: LngLat[] = [];
    for (let y = 0; y <= 40; y += 2) line.push([0, y * M]);
    for (let deg = 10; deg < 180; deg += 10) {
      const a = (deg * Math.PI) / 180;
      line.push([side * (apart / 2) * (1 - Math.cos(a)) * M, (40 + (apart / 2) * Math.sin(a)) * M]);
    }
    for (let y = 40; y >= 10; y -= 2) line.push([side * apart * M, y * M]);
    return line;
  };

  it.each([0, 0.5, 1, 2, 3, 3.5, 3.75])("on a U-turn whose legs are %d m apart", (apart) => {
    for (const side of [1, -1] as const) {
      const ring = raisedArrowPolygon(uTurn(apart, side), 2.4, 5);
      expect(ring.length).toBeGreaterThan(0);
      expect(crossings(ring)).toEqual([]);
    }
  });

  /** North 40 m, then 40 m on at `turn` degrees right of north. */
  const corner = (turn: number): LngLat[] => {
    const line: LngLat[] = [];
    for (let y = 0; y <= 40; y += 2) line.push([0, y * M]);
    const b = (turn * Math.PI) / 180;
    for (let d = 2; d <= 40; d += 2) line.push([Math.sin(b) * d * M, (40 + Math.cos(b) * d) * M]);
    return line;
  };

  it.each([155, 160, 170, 175, 179, -160, -179])("round a %d° hairpin corner", (turn) => {
    const ring = raisedArrowPolygon(corner(turn), 2.4, 5);
    expect(ring.length).toBeGreaterThan(0);
    expect(crossings(ring)).toEqual([]);
  });
});

describe("the raised arrow on a tight turn", () => {
  const M = 1 / 111_195;
  const uTurn = (apart: number): LngLat[] => {
    const line: LngLat[] = [];
    for (let y = 0; y <= 40; y += 2) line.push([0, y * M]);
    for (let deg = 10; deg < 180; deg += 10) {
      const a = (deg * Math.PI) / 180;
      line.push([(apart / 2) * (1 - Math.cos(a)) * M, (40 + (apart / 2) * Math.sin(a)) * M]);
    }
    for (let y = 40; y >= 10; y -= 2) line.push([apart * M, y * M]);
    return line;
  };
  /** Across the ring, east to west, at `north` m: the shaft's width there. */
  const spanAt = (ring: LngLat[], north: number) => {
    const xs: number[] = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const [a, b] = [ring[i] as LngLat, ring[i + 1] as LngLat];
      const [ya, yb] = [a[1] / M, b[1] / M];
      if ((ya - north) * (yb - north) <= 0 && ya !== yb) {
        xs.push((a[0] + ((b[0] - a[0]) * (north - ya)) / (yb - ya)) / M);
      }
    }
    return xs.sort((p, q) => p - q);
  };

  it("keeps its full size where the legs are far enough apart", () => {
    // Legs 5 m apart: each shaft 2.4 m wide at 21 m north.
    const [a, b, c, d] = spanAt(raisedArrowPolygon(uTurn(5), 2.4, 5), 21);
    expect((b as number) - (a as number)).toBeCloseTo(2.4, 1);
    expect((d as number) - (c as number)).toBeCloseTo(2.4, 1);
  });

  it("narrows where the legs are too close for the full width", () => {
    // Legs 3 m apart: a 2.4 m shaft beside a 4.8 m head would overlap.
    const [a, b, c, d] = spanAt(raisedArrowPolygon(uTurn(3), 2.4, 5), 21);
    expect((b as number) - (a as number)).toBeLessThan(2.4);
    expect((b as number) - (a as number)).toBeGreaterThan(1);
    expect(c as number).toBeGreaterThan(b as number);
    expect((d as number) - (c as number)).toBeCloseTo((b as number) - (a as number), 1);
  });

  it("opens a U-turn back along the same road into the two sides of the road", () => {
    // Driving on the right, a U-turn goes left: up the east side, back down
    // the west side, each leg on the right of its own travel.
    const [a, b, c, d] = spanAt(raisedArrowPolygon(uTurn(0), 2.4, 5), 21);
    expect((b as number) - (a as number)).toBeCloseTo(2.4, 1);
    expect((d as number) - (c as number)).toBeCloseTo(2.4, 1);
    expect(b as number).toBeLessThan(c as number);
    expect(a as number).toBeLessThan(0);
    expect(d as number).toBeGreaterThan(0);
  });

  it("puts the way up on the west side where traffic drives on the left", () => {
    // Up the west side heading north, round to the right, back down the east side.
    const right = raisedArrowPolygon(uTurn(0), 2.4, 5, { drivingSide: "right" });
    const left = raisedArrowPolygon(uTurn(0), 2.4, 5, { drivingSide: "left" });
    // The ring starts on the left edge of the shaft at its foot.
    expect((right[0] as LngLat)[0]).toBeGreaterThan(0);
    expect((left[0] as LngLat)[0]).toBeLessThan(0);
  });
});

describe("smoothArrowLine", () => {
  // The right turn from Alt-Moabit into Gotzkowskystraße (Berlin) as the route
  // draws it: about 15 m before the corner the line steps some 3 m sideways
  // onto the divided carriageway, which the wide arrow shows as a zig-zag.
  const gotzkowsky: LngLat[] = [
    [13.32892, 52.52397],
    [13.328962, 52.523961],
    [13.329159, 52.523914],
    [13.329352, 52.523862],
    [13.329423, 52.523806],
    [13.329452, 52.523796],
    [13.329479, 52.523785],
    [13.329557, 52.52376],
    [13.329636, 52.523734],
    [13.329623, 52.523699],
    [13.329608, 52.523653],
    [13.329605, 52.523615],
    [13.329584, 52.523446],
  ];
  const corner: LngLat = [13.329636, 52.523734];

  /**
   * The largest change of direction between consecutive 1 m chords of the
   * line, from its start to `stopMeters` before `corner`: a kink shows up
   * however the line happens to be divided into vertices.
   */
  function sharpestKink(line: LngLat[], stopMeters: number): number {
    const lineCum = cumulativeDistances(line);
    const total = distanceAtVertex(lineCum, lineCum.length - 1);
    const points: LngLat[] = [];
    for (let at = 0; at <= total; at += 1) {
      const point = positionAt(line, lineCum, at).point;
      if (haversineDistance(point, corner) < stopMeters) break;
      points.push(point);
    }
    let sharpest = 0;
    for (let i = 2; i < points.length; i++) {
      const [a, b, c] = [points[i - 2], points[i - 1], points[i]] as [LngLat, LngLat, LngLat];
      const turn = Math.abs(((bearingBetween(b, c) - bearingBetween(a, b) + 540) % 360) - 180);
      sharpest = Math.max(sharpest, turn);
    }
    return sharpest;
  }

  it("irons out the sideways step before the turn", () => {
    expect(sharpestKink(gotzkowsky, 10)).toBeGreaterThan(10);
    expect(sharpestKink(smoothArrowLine(gotzkowsky), 10)).toBeLessThan(4);
  });

  it("keeps the ends and the direction of the head", () => {
    const smooth = smoothArrowLine(gotzkowsky);
    expect(smooth[0]).toEqual(gotzkowsky[0]);
    expect(smooth.at(-1)).toEqual(gotzkowsky.at(-1));
    const tipTurn = Math.abs(
      ((maneuverArrowTipBearing(smooth) - maneuverArrowTipBearing(gotzkowsky) + 540) % 360) - 180,
    );
    expect(tipTurn).toBeLessThan(3);
  });

  it("stays on the road", () => {
    const cumRaw = cumulativeDistances(gotzkowsky);
    const total = distanceAtVertex(cumRaw, cumRaw.length - 1);
    const samples = Array.from(
      { length: Math.ceil(total * 4) + 1 },
      (_, i) => positionAt(gotzkowsky, cumRaw, Math.min(i / 4, total)).point,
    );
    for (const p of smoothArrowLine(gotzkowsky)) {
      const nearest = Math.min(...samples.map((s) => haversineDistance(p, s)));
      expect(nearest).toBeLessThan(2);
    }
  });

  it("leaves a straight line straight and short lines alone", () => {
    const straight = smoothArrowLine([
      [0, 0],
      [0.004, 0],
      [0.01, 0],
    ]);
    for (const p of straight) expect(Math.abs(p[1])).toBeLessThan(1e-9);
    const stub: LngLat[] = [
      [0, 0],
      [0.000005, 0],
      [0.000005, 0.000005],
    ];
    expect(smoothArrowLine(stub)).toEqual(stub);
  });
});
