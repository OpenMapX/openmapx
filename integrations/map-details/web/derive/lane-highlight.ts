import type { ManeuverLane } from "@openmapx/core";
import { matchLanes } from "@openmapx/core/navigation/laneMatch";
import type { DecodedTile, TileFeature } from "./decode";
import { wayIdOf } from "./decode";
import { isLeftHandTraffic } from "./driving-side";
import { crossSection, isMotorRoad, type Lane } from "./roads";

/**
 * The recommended lanes of the next maneuver as polygons on the road
 * (immersive navigation spec §9.2). Only exact agreement between the routing
 * engine's lanes and the OSM lanes of the way the car arrives on draws
 * anything; every doubt answers with a reason and no polygons.
 *
 * The polygons follow the route's own approach line, which runs along the
 * way's centre line; the street detail tiles supply the way's tags, its
 * digitised direction, how far back it reaches, and the crossing roads that
 * set where the junction begins.
 */

export type LaneHighlightReason =
  | "no-way"
  | "no-ids"
  | "direction"
  | "class-excluded"
  | "count"
  | "turn-missing"
  | "indications"
  | "no-lanes";

export type LaneHighlightAnswer =
  | {
      polygons: [number, number][][];
      /** Metres back from the maneuver along the approach where the highlight starts. */
      startBeforeManeuver: number;
      /** Metres back from the maneuver where it ends (the junction cut-back). */
      endBeforeManeuver: number;
      /**
       * Sideways distance from the route line to the centre of the recommended
       * lane nearest it, positive to the right of travel. The manoeuvre arrow
       * runs there, so it points into the same lane as the highlight.
       */
      laneOffsetMeters: number;
    }
  | { polygons: null; reason: LaneHighlightReason };

export interface LaneHighlightInput {
  tiles: { z: 16; x: number; y: number; tile: DecodedTile }[];
  wayId: number;
  /** Route geometry before the maneuver, in travel order; its last point is the maneuver. */
  approach: [number, number][];
  engineLanes: ManeuverLane[];
  /** Engine lane indices to draw (the recommended lanes after narrowing). */
  recommended: number[];
  classes: ("urban" | "motorway")[];
}

type P = [number, number];

const EARTH_RADIUS_M = 6371008.8;
const HIGHLIGHT_LENGTH_M = 120;
const DIRECTION_TOLERANCE_DEG = 45;
/** A crossing road whose vertex lies this close to the maneuver forms the junction. */
const JUNCTION_VERTEX_M = 2;
const CUT_MARGIN_M = 1;
/** An approach sample this close to the way's line still lies on the way. */
const ON_WAY_M = 3;
const SAMPLE_STEP_M = 2;
const MIN_HIGHLIGHT_M = 5;
const MOTORWAY_CLASSES = new Set(["motorway", "motorway_link", "trunk", "trunk_link"]);

/** A local east/north metre frame around `origin` (accurate over a few hundred metres). */
function localFrame(origin: P) {
  const cos = Math.cos((origin[1] * Math.PI) / 180);
  const k = (Math.PI / 180) * EARTH_RADIUS_M;
  return {
    toLocal: ([lng, lat]: P): P => [(lng - origin[0]) * k * cos, (lat - origin[1]) * k],
    toLngLat: ([x, y]: P): P => [origin[0] + x / (k * cos), origin[1] + y / k],
  };
}

function tileToLngLat(x: number, y: number, extent: number, [px, py]: P): P {
  const n = 2 ** 16;
  const lng = ((x + px / extent) / n) * 360 - 180;
  const merc = Math.PI * (1 - (2 * (y + py / extent)) / n);
  return [lng, (Math.atan(Math.sinh(merc)) * 180) / Math.PI];
}

function distanceToSegment(p: P, a: P, b: P): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t =
    length2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function distanceToLines(p: P, lines: P[][]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const line of lines)
    for (let i = 1; i < line.length; i++)
      best = Math.min(best, distanceToSegment(p, line[i - 1] as P, line[i] as P));
  return best;
}

function cumulative(line: P[]): number[] {
  const out = [0];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1] as P;
    const b = line[i] as P;
    out.push((out[i - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return out;
}

function pointAt(line: P[], cum: number[], along: number): P {
  for (let i = 1; i < line.length; i++) {
    if ((cum[i] as number) >= along) {
      const a = line[i - 1] as P;
      const b = line[i] as P;
      const span = (cum[i] as number) - (cum[i - 1] as number);
      const t = span > 0 ? (along - (cum[i - 1] as number)) / span : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
  }
  return line[line.length - 1] as P;
}

/** The part of `line` between two along-distances, including both cut points. */
function slice(line: P[], cum: number[], from: number, to: number): P[] {
  const out: P[] = [pointAt(line, cum, from)];
  for (let i = 0; i < line.length; i++)
    if ((cum[i] as number) > from && (cum[i] as number) < to) out.push(line[i] as P);
  out.push(pointAt(line, cum, to));
  return out;
}

/** `line` offset sideways by `offset` metres, positive to the right of travel. */
function offsetLine(line: P[], offset: number): P[] {
  return line.map((p, i) => {
    const a = line[Math.max(0, i - 1)] as P;
    const b = line[Math.min(line.length - 1, i + 1)] as P;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy) || 1;
    // Facing (dx, dy) with y north, the right-hand normal is (dy, −dx).
    return [p[0] + (dy / length) * offset, p[1] - (dx / length) * offset];
  });
}

export function laneHighlight(input: LaneHighlightInput): LaneHighlightAnswer {
  const maneuver = input.approach[input.approach.length - 1];
  if (!maneuver || input.approach.length < 2) return { polygons: null, reason: "no-way" };
  const frame = localFrame(maneuver);
  const approach = input.approach.map(frame.toLocal);

  // The way's pieces (clipped per tile) and the other roads, in local metres.
  const wayLines: P[][] = [];
  const others: { feature: TileFeature; lines: P[][] }[] = [];
  let wayFeature: TileFeature | null = null;
  let anyId = false;
  for (const { x, y, tile } of input.tiles) {
    for (const feature of tile.layers.roads ?? []) {
      if (feature.type !== 2) continue;
      const lines = feature.geometry.map((line) =>
        line.map((p) => frame.toLocal(tileToLngLat(x, y, tile.extent, p))),
      );
      const id = wayIdOf(feature);
      if (id !== null) anyId = true;
      if (id === input.wayId) {
        wayFeature ??= feature;
        wayLines.push(...lines);
      } else if (isMotorRoad(feature.props)) {
        others.push({ feature, lines });
      }
    }
  }
  if (!wayFeature) return { polygons: null, reason: anyId ? "no-way" : "no-ids" };

  const roadClass = String(wayFeature.props.class ?? "");
  const kind = MOTORWAY_CLASSES.has(roadClass) ? "motorway" : "urban";
  if (!input.classes.includes(kind)) return { polygons: null, reason: "class-excluded" };

  // Digitised direction of the way where it meets the maneuver, against the travel direction.
  let nearest: { d: number; a: P; b: P } | null = null;
  for (const line of wayLines)
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1] as P;
      const b = line[i] as P;
      const d = distanceToSegment([0, 0], a, b);
      if (!nearest || d < nearest.d) nearest = { d, a, b };
    }
  if (!nearest) return { polygons: null, reason: "no-way" };
  const last = approach[approach.length - 2] as P;
  const travel: P = [-last[0], -last[1]];
  const digitised: P = [nearest.b[0] - nearest.a[0], nearest.b[1] - nearest.a[1]];
  const cosAngle =
    (travel[0] * digitised[0] + travel[1] * digitised[1]) /
    ((Math.hypot(...travel) || 1) * (Math.hypot(...digitised) || 1));
  const angle = (Math.acos(Math.max(-1, Math.min(1, cosAngle))) * 180) / Math.PI;
  const forward = angle <= DIRECTION_TOLERANCE_DEG;
  if (!forward && angle < 180 - DIRECTION_TOLERANCE_DEG)
    return { polygons: null, reason: "direction" };

  const leftHand = isLeftHandTraffic(maneuver[0], maneuver[1]);
  const section = crossSection(wayFeature.props, leftHand);
  // The cross-section is oriented along the digitised line, or against it for
  // `oneway=-1`; travelling with that orientation uses the forward lanes.
  const withSection = section.reversed ? !forward : forward;
  if (section.oneway && !withSection) return { polygons: null, reason: "direction" };
  const travelLanes: Lane[] = withSection
    ? section.lanes.filter((lane) => lane.dir === "fw")
    : section.lanes.filter((lane) => lane.dir === "bw").reverse();
  const sideSign = withSection ? 1 : -1;

  const match = matchLanes(
    input.engineLanes,
    travelLanes.map((lane) => ({ kind: lane.kind, turn: lane.turn })),
  );
  if (!match.agree) return { polygons: null, reason: match.reason };

  // The junction begins where the widest crossing road's edge is, plus a metre.
  let cut = 0;
  for (const other of others) {
    const touches = other.lines.some((line) =>
      line.some((p) => Math.hypot(p[0], p[1]) <= JUNCTION_VERTEX_M),
    );
    if (!touches) continue;
    cut = Math.max(cut, crossSection(other.feature.props, leftHand).width / 2 + CUT_MARGIN_M);
  }

  // Walk back from the cut-back while the approach stays on the way.
  const cum = cumulative(approach);
  const total = cum[cum.length - 1] as number;
  const limit = Math.min(total, cut + HIGHLIGHT_LENGTH_M);
  let start = cut;
  for (let back = cut; back <= limit; back += SAMPLE_STEP_M) {
    if (distanceToLines(pointAt(approach, cum, total - back), wayLines) > ON_WAY_M) break;
    start = back;
  }
  if (start - cut < MIN_HIGHLIGHT_M) return { polygons: null, reason: "no-way" };

  const centre = slice(approach, cum, total - start, total - cut);
  let laneOffsetMeters: number | null = null;
  const polygons = input.recommended.flatMap((engineIndex) => {
    const osmIndex = match.engineToOsm[engineIndex];
    const lane = osmIndex === undefined ? undefined : travelLanes[osmIndex];
    if (!lane) return [];
    const offset = sideSign * lane.offset;
    if (laneOffsetMeters === null || Math.abs(offset) < Math.abs(laneOffsetMeters)) {
      laneOffsetMeters = offset;
    }
    const leftEdge = offsetLine(centre, offset - lane.width / 2);
    const rightEdge = offsetLine(centre, offset + lane.width / 2);
    const ring = [...leftEdge, ...rightEdge.reverse()];
    ring.push(ring[0] as P);
    return [ring.map(frame.toLngLat)];
  });
  if (laneOffsetMeters === null) return { polygons: null, reason: "no-lanes" };
  return {
    polygons,
    startBeforeManeuver: start,
    endBeforeManeuver: cut,
    laneOffsetMeters,
  };
}
