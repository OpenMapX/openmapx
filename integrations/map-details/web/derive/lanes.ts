import type { TileFeature } from "./decode";
import { bufferPolyline, dashes, offsetPolyline, type Pt, type Ring, slice } from "./geometry";
import {
  type CrossSection,
  isMajorClass,
  isMotorRoad,
  layerOf,
  linesInMetres,
  type PaintKind,
  type PaintPolygon,
} from "./roads";

/**
 * Lane strips, dividers and their trimming at junctions (spec §5.3, §5.4).
 * Metres in the tile frame, as in `roads.ts`.
 */

/** A paintable stretch of a road line between junctions, along travel. */
export interface RoadPiece {
  /** The whole line in metres, oriented along travel. */
  line: Pt[];
  startM: number;
  endM: number;
  /** The piece starts or ends at a junction's cut-back point (a stop line at the end). */
  startAtJunction: boolean;
  endAtJunction: boolean;
}

const LINE_HALF_WIDTH = 0.075;
const DASH: [number, number] = [3, 6];
const MAJOR_DASH: [number, number] = [6, 12];
const JUNCTION_CLEARANCE_M = 1;
const MIN_PIECE_M = 0.1;

const vertexKey = ([x, y]: Pt) => `${Math.round(x)},${Math.round(y)}`;

/**
 * Split each motor road line at the vertices it shares with other motor roads
 * of the same layer, and cut each side back by the largest half-width among
 * the other roads there plus 1 m. Returns, per road index, its pieces.
 */
export function junctionCuts(
  roads: TileFeature[],
  sections: CrossSection[],
  mpu: number,
): RoadPiece[][] {
  const meeting = new Map<string, Array<{ road: number; layer: number; half: number }>>();
  roads.forEach((road, index) => {
    const section = sections[index];
    if (road.type !== 2 || !isMotorRoad(road.props) || !section) return;
    const seen = new Set<string>();
    for (const line of road.geometry)
      for (const point of line) {
        const key = vertexKey(point);
        if (seen.has(key)) continue;
        seen.add(key);
        const list = meeting.get(key) ?? [];
        list.push({ road: index, layer: layerOf(road.props), half: section.width / 2 });
        meeting.set(key, list);
      }
  });

  return roads.map((road, index) => {
    const section = sections[index];
    if (road.type !== 2 || !isMotorRoad(road.props) || !section) return [];
    const layer = layerOf(road.props);
    const pieces: RoadPiece[] = [];
    road.geometry.forEach((raw, lineIndex) => {
      const tilePoints = section.reversed ? [...raw].reverse() : raw;
      const line = linesInMetres(road, mpu, section.reversed)[lineIndex] ?? [];
      const stops: Array<{ d: number; cut: number }> = [];
      let walked = 0;
      tilePoints.forEach((point, k) => {
        if (k > 0) {
          const a = line[k - 1] as Pt;
          const b = line[k] as Pt;
          walked += Math.hypot(b[0] - a[0], b[1] - a[1]);
        }
        const others = (meeting.get(vertexKey(point)) ?? []).filter(
          (entry) => entry.road !== index && entry.layer === layer,
        );
        if (others.length > 0)
          stops.push({
            d: walked,
            cut: Math.max(...others.map((o) => o.half)) + JUNCTION_CLEARANCE_M,
          });
      });
      const bounds = [
        ...(stops[0]?.d === 0 ? [] : [{ d: 0, cut: 0 }]),
        ...stops,
        ...(stops[stops.length - 1]?.d === walked ? [] : [{ d: walked, cut: 0 }]),
      ];
      for (let i = 1; i < bounds.length; i++) {
        const from = bounds[i - 1] as { d: number; cut: number };
        const to = bounds[i] as { d: number; cut: number };
        const startM = from.d + from.cut;
        const endM = to.d - to.cut;
        if (endM - startM < MIN_PIECE_M) continue;
        pieces.push({
          line,
          startM,
          endM,
          startAtJunction: from.cut > 0,
          endAtJunction: to.cut > 0,
        });
      }
    });
    return pieces;
  });
}

function stroke(line: Pt[], dash: [number, number] | null): Ring[] {
  if (line.length < 2) return [];
  if (!dash) return bufferPolyline(line, LINE_HALF_WIDTH);
  return dashes(line, dash[0], dash[1]).flatMap((piece) => bufferPolyline(piece, LINE_HALF_WIDTH));
}

/** Bus and cycle strips, lane dividers on marked roads and every cycle lane's edge line. */
export function lanePaint(
  roads: TileFeature[],
  sections: CrossSection[],
  cuts: RoadPiece[][],
  _mpu: number,
): PaintPolygon[] {
  const out: PaintPolygon[] = [];
  roads.forEach((road, index) => {
    const section = sections[index];
    if (road.type !== 2 || !isMotorRoad(road.props) || !section) return;
    const rings: Record<"bus" | "cycle" | "marking", Ring[]> = { bus: [], cycle: [], marking: [] };
    const sameDirection = isMajorClass(String(road.props.class)) ? MAJOR_DASH : DASH;
    const motorLanes = section.lanes.filter((lane) => lane.kind !== "cycle").length;
    for (const piece of cuts[index] ?? []) {
      const segment = slice(piece.line, piece.startM, piece.endM);
      if (segment.length < 2) continue;
      for (const lane of section.lanes) {
        if (lane.kind === "general") continue;
        rings[lane.kind].push(
          ...bufferPolyline(offsetPolyline(segment, lane.offset), lane.width / 2),
        );
      }
      for (let j = 0; j + 1 < section.lanes.length; j++) {
        const a = section.lanes[j];
        const b = section.lanes[j + 1];
        if (!a || !b) continue;
        const boundary = offsetPolyline(segment, a.offset + a.width / 2);
        if (a.kind === "cycle" || b.kind === "cycle") {
          const cycle = a.kind === "cycle" ? a : b;
          rings.marking.push(...stroke(boundary, cycle.exclusive ? null : DASH));
        } else if (section.marked) {
          const dash = a.dir === b.dir ? sameDirection : motorLanes >= 4 ? null : DASH;
          rings.marking.push(...stroke(boundary, dash));
        }
      }
    }
    const layer = layerOf(road.props);
    for (const kind of ["bus", "cycle", "marking"] as const)
      if (rings[kind].length > 0) out.push({ kind: kind as PaintKind, layer, rings: rings[kind] });
  });
  return out;
}
