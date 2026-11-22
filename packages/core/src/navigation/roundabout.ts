import type { LngLat } from "../types/geometry";
import { bearingBetween } from "./bearing";

/**
 * Which way traffic circles a roundabout, seen from above: counter-clockwise
 * where it drives on the right, clockwise where it drives on the left.
 */
export type RoundaboutCirculation = "ccw" | "cw";

/** How a roundabout is driven: its circulation and how far round the exit lies. */
export interface RoundaboutTurn {
  circulation: RoundaboutCirculation;
  /**
   * Degrees travelled round the circle from the way in to the exit, in the
   * direction of circulation, in (0, 360]. With four evenly spaced arms the
   * first exit is at 90, straight on at 180 and the way back in at 360, as
   * Android for Cars' `setRoundaboutExitAngle` counts.
   */
  exitAngle: number;
}

/** The parts of a route step a roundabout's turn is read from. */
export interface RoundaboutStep {
  maneuver?: { type: string; modifier?: string };
  coordinates?: readonly LngLat[];
  bearingBefore?: number;
  bearingAfter?: number;
  drivingSide?: "left" | "right";
}

const isEntry = (step: RoundaboutStep | undefined) =>
  step?.maneuver?.type === "roundabout" || step?.maneuver?.type === "rotary";
const isExit = (step: RoundaboutStep | undefined) =>
  step?.maneuver?.type === "exit roundabout" || step?.maneuver?.type === "exit rotary";

/** Bend round the circle, in degrees, below which the path says nothing about circulation. */
const MIN_BEND_DEG = 15;

const finite = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Signed difference b − a in (−180, 180]: positive turns right. */
function turnBetween(a: number, b: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return d === -180 ? 180 : d;
}

/** Bearings of the path's segments, skipping points that repeat. */
function segmentBearings(points: readonly LngLat[]): number[] {
  const bearings: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as LngLat;
    const b = points[i] as LngLat;
    if (a[0] !== b[0] || a[1] !== b[1]) bearings.push(bearingBetween(a, b));
  }
  return bearings;
}

/** Total signed bend along the path: positive bends right (clockwise). */
function bend(points: readonly LngLat[]): number {
  const bearings = segmentBearings(points);
  let total = 0;
  for (let i = 1; i < bearings.length; i++) {
    total += turnBetween(bearings[i - 1] as number, bearings[i] as number);
  }
  return total;
}

function circulationOf(step: RoundaboutStep): RoundaboutCirculation {
  if (step.drivingSide === "left") return "cw";
  if (step.drivingSide === "right") return "ccw";
  // Engines that name no driving side (Valhalla) still draw the way round.
  const bent = bend(step.coordinates ?? []);
  if (bent >= MIN_BEND_DEG) return "cw";
  // Most of the world drives on the right, so a path too short to bend
  // (a mini-roundabout) is read as counter-clockwise.
  return "ccw";
}

function turnOf(
  previous: RoundaboutStep | undefined,
  step: RoundaboutStep,
  next: RoundaboutStep | undefined,
): RoundaboutTurn | undefined {
  const path = step.coordinates ?? [];
  const entry = finite(step.bearingBefore)
    ? step.bearingBefore
    : (segmentBearings(previous?.coordinates ?? []).at(-1) ?? segmentBearings(path)[0]);
  // The exit step starts where the roundabout is left; without one (OSRM),
  // the roundabout step runs on along the exit road.
  const exit = isExit(next)
    ? finite(next?.bearingAfter)
      ? next.bearingAfter
      : segmentBearings(next?.coordinates ?? [])[0]
    : segmentBearings(path).at(-1);
  if (entry === undefined || exit === undefined) return undefined;
  const circulation = circulationOf(step);
  const turn = turnBetween(entry, exit);
  const angle = (((circulation === "ccw" ? 180 - turn : 180 + turn) % 360) + 360) % 360;
  return { circulation, exitAngle: angle < 0.5 ? 360 : Math.round(angle * 10) / 10 };
}

/**
 * The turn at the roundabout step `index`, or at the roundabout that the exit
 * step `index` leaves; undefined for any other step.
 */
export function roundaboutTurnAt(
  steps: readonly (RoundaboutStep | undefined)[],
  index: number,
): RoundaboutTurn | undefined {
  const step = steps[index];
  if (isExit(step) && isEntry(steps[index - 1])) return roundaboutTurnAt(steps, index - 1);
  if (!step || !isEntry(step)) return undefined;
  return turnOf(steps[index - 1], step, steps[index + 1]);
}

/** A glyph as SVG path data on a 24 × 24 grid: lines to stroke, shapes to fill. */
export interface GuidanceGlyph {
  /** Lines to stroke; `opacity` (0–1, default 1) dims the parts not driven. */
  strokes: { d: string; width: number; opacity?: number }[];
  fills: string[];
}

const CENTRE: LngLat = [12, 11];
const RADIUS = 5;
/** The exit from the circle to the arrow's tip, and the head's length and half-width. */
const EXIT_LENGTH = 5.5;
const HEAD_LENGTH = 4.5;
const HEAD_HALF_WIDTH = 3.6;
/** Exits closer to the way in than this are drawn this far round, beside it. */
const MIN_DRAWN_DEG = 30;

const round = (value: number) => String(Math.round(value * 100) / 100);

/**
 * The roundabout as one glyph: the way in from below, round the circle in the
 * direction of travel, out along the exit with an arrowhead, and the rest of
 * the circle dimmed. Clockwise circulation is the mirror image.
 */
export function roundaboutGlyph(turn: RoundaboutTurn): GuidanceGlyph {
  const mirror = turn.circulation === "cw" ? -1 : 1;
  const angle = Math.min(Math.max(turn.exitAngle, MIN_DRAWN_DEG), 360 - MIN_DRAWN_DEG);
  // Travel angle φ from the bottom of the circle; counter-clockwise on screen
  // runs up its right side first. The y axis points down.
  const at = (deg: number, distance = RADIUS): LngLat => {
    const a = (deg * Math.PI) / 180;
    return [CENTRE[0] + mirror * distance * Math.sin(a), CENTRE[1] + distance * Math.cos(a)];
  };
  const point = ([x, y]: LngLat) => `${round(x)} ${round(y)}`;
  // On a y-down grid, sweep flag 0 runs counter-clockwise on screen.
  const sweep = turn.circulation === "cw" ? 1 : 0;
  const arcTo = (from: number, to: number) =>
    `A${RADIUS} ${RADIUS} 0 ${to - from > 180 ? 1 : 0} ${sweep} ${point(at(to))}`;
  const entry = at(0);
  const out = at(angle);
  const headBase = at(angle, RADIUS + EXIT_LENGTH - HEAD_LENGTH);
  const tip = at(angle, RADIUS + EXIT_LENGTH);
  const a = (angle * Math.PI) / 180;
  // Across the exit: perpendicular to its outward direction.
  const across: LngLat = [Math.cos(a), -mirror * Math.sin(a)];
  const corner = (side: number): LngLat => [
    headBase[0] + side * HEAD_HALF_WIDTH * across[0],
    headBase[1] + side * HEAD_HALF_WIDTH * across[1],
  ];
  return {
    strokes: [
      { d: `M${point(out)} ${arcTo(angle, 360)}`, width: 2.2, opacity: 0.4 },
      {
        d: `M12 23 L${point(entry)} ${arcTo(0, angle)} L${point(headBase)}`,
        width: 3,
      },
    ],
    fills: [`M${point(tip)} L${point(corner(1))} L${point(corner(-1))} Z`],
  };
}
