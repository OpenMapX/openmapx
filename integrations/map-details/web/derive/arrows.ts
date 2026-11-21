import type { TileFeature } from "./decode";
import {
  bufferPolyline,
  type Pt,
  pointAlong,
  polylineLength,
  type Ring,
  transformTemplate,
} from "./geometry";
import type { RoadPiece } from "./lanes";
import { type CrossSection, isMotorRoad, layerOf, type PaintPolygon } from "./roads";

/**
 * Turn arrows from valid `turn:lanes*` lists (spec §5.3). Glyphs are metre
 * templates 5 m long, pointing +y (forward), with +x to the right of travel:
 * 1.2 m wide for straight ahead, up to 1.6 m for arrows that turn, so the
 * shaft can curve towards the turn and end in a full-size head.
 */

const GLYPH_LENGTH = 5;
const SHAFT_HALF_WIDTH = 0.15;
const HEAD_LENGTH = 0.9;
const HEAD_HALF_WIDTH = 0.42;
const ARC_STEP_RAD = Math.PI / 12;

/** Place rings so the glyph runs from v = −2.5 to +2.5 and is centred across. */
function fit(rings: Ring[]): Ring[] {
  const points = rings.flat();
  const minU = Math.min(...points.map((p) => p[0]));
  const maxU = Math.max(...points.map((p) => p[0]));
  const shiftU = -(minU + maxU) / 2;
  return rings.map((ring) => ring.map(([u, v]): Pt => [u + shiftU, v]));
}

/** A shaft from the bottom centre along `path`, ending in a head along its last direction. */
function strokeWithHead(path: Pt[], direction: Pt): Ring[] {
  const end = path[path.length - 1] as Pt;
  const across: Pt = [direction[1], -direction[0]];
  const head: Ring = [
    [end[0] + across[0] * HEAD_HALF_WIDTH, end[1] + across[1] * HEAD_HALF_WIDTH],
    [end[0] + direction[0] * HEAD_LENGTH, end[1] + direction[1] * HEAD_LENGTH],
    [end[0] - across[0] * HEAD_HALF_WIDTH, end[1] - across[1] * HEAD_HALF_WIDTH],
  ];
  return [...bufferPolyline(path, SHAFT_HALF_WIDTH), head];
}

/**
 * An arrow that runs straight, then turns by `degrees` (positive to the left)
 * on an arc of `radius` metres. The straight part takes whatever length is
 * left so the glyph is exactly 5 m long.
 */
function turnArrow(degrees: number, radius: number): Ring[] {
  const theta = (Math.abs(degrees) * Math.PI) / 180;
  const side = degrees >= 0 ? -1 : 1;
  const build = (straight: number) => {
    const startV = -GLYPH_LENGTH / 2;
    const bendV = startV + straight;
    const path: Pt[] = [
      [0, startV],
      [0, bendV],
    ];
    const steps = Math.max(1, Math.ceil(theta / ARC_STEP_RAD));
    for (let i = 1; i <= steps && theta > 0; i++) {
      const phi = (theta * i) / steps;
      path.push([side * (radius - radius * Math.cos(phi)), bendV + radius * Math.sin(phi)]);
    }
    return strokeWithHead(path, [side * Math.sin(theta), Math.cos(theta)]);
  };
  const top = Math.max(
    ...build(0)
      .flat()
      .map((p) => p[1]),
  );
  return fit(build(GLYPH_LENGTH / 2 - top));
}

/** An arrow slanted `degrees` to the left all the way, for merging into the next lane. */
function slantedArrow(degrees: number): Ring[] {
  const alpha = (degrees * Math.PI) / 180;
  const direction: Pt = [-Math.sin(alpha), Math.cos(alpha)];
  // A short straight lead keeps the foot square to the lane.
  const lead = 0.4;
  const build = (length: number) =>
    strokeWithHead(
      [
        [0, -GLYPH_LENGTH / 2],
        [0, -GLYPH_LENGTH / 2 + lead],
        [direction[0] * length, -GLYPH_LENGTH / 2 + lead + direction[1] * length],
      ],
      direction,
    );
  const top = Math.max(
    ...build(0)
      .flat()
      .map((p) => p[1]),
  );
  return fit(build((GLYPH_LENGTH / 2 - top) / direction[1]));
}

const mirror = (rings: Ring[]): Ring[] =>
  rings.map((ring) => ring.map(([u, v]): Pt => [-u, v]).reverse());

const LEFT = turnArrow(75, 0.6);
const SLIGHT_LEFT = turnArrow(30, 1.2);
const SHARP_LEFT = turnArrow(135, 0.4);
const MERGE_TO_LEFT = slantedArrow(12);

export const ARROW_GLYPHS: Record<string, Ring[]> = {
  through: turnArrow(0, 1),
  left: LEFT,
  right: mirror(LEFT),
  slight_left: SLIGHT_LEFT,
  slight_right: mirror(SLIGHT_LEFT),
  sharp_left: SHARP_LEFT,
  sharp_right: mirror(SHARP_LEFT),
  reverse: turnArrow(180, 0.45),
  merge_to_left: MERGE_TO_LEFT,
  merge_to_right: mirror(MERGE_TO_LEFT),
};

/** The union of the glyphs of a lane's turn values; `none`, empty and unknown values draw nothing. */
export function glyphUnion(values: string[]): Ring[] {
  // Turn values come from OSM: look them up among the table's own keys only.
  return values.flatMap((value) =>
    Object.hasOwn(ARROW_GLYPHS, value) ? (ARROW_GLYPHS[value] ?? []) : [],
  );
}

const ARROW_HALF_LENGTH = 2.5;
const OFFSETS_M = [4, 24] as const;
const FIRST_NEEDS_M = 4 + 2 * ARROW_HALF_LENGTH;
const SECOND_NEEDS_M = 34;
const BOUNDARY_TOLERANCE_M = 0.25;

/**
 * Arrows at 4 m and 24 m before each stop line, centred in each lane with a
 * valid turn list. A stop line is a junction cut-back point, or a line end
 * that lies inside the buffered tile (an end on the buffer boundary is where
 * the tile clipped the road, not where it ends). `buffered` is the buffered
 * tile square in metres. Forward lanes stop at a piece's end, backward lanes
 * at its start.
 */
export function turnArrows(
  roads: TileFeature[],
  sections: CrossSection[],
  cuts: RoadPiece[][],
  _mpu: number,
  buffered: { min: number; max: number },
): PaintPolygon[] {
  const onBoundary = ([x, y]: Pt) =>
    Math.abs(x - buffered.min) < BOUNDARY_TOLERANCE_M ||
    Math.abs(x - buffered.max) < BOUNDARY_TOLERANCE_M ||
    Math.abs(y - buffered.min) < BOUNDARY_TOLERANCE_M ||
    Math.abs(y - buffered.max) < BOUNDARY_TOLERANCE_M;
  const out: PaintPolygon[] = [];
  roads.forEach((road, index) => {
    const section = sections[index];
    if (road.type !== 2 || !isMotorRoad(road.props) || !section) return;
    const turning = section.lanes.filter((lane) => lane.turn && glyphUnion(lane.turn).length > 0);
    if (turning.length === 0) return;
    const rings: Ring[] = [];
    for (const piece of cuts[index] ?? []) {
      const length = polylineLength(piece.line);
      const available = piece.endM - piece.startM;
      const endIsStop =
        piece.endAtJunction ||
        (Math.abs(piece.endVertexM - length) < 1e-6 &&
          !onBoundary(pointAlong(piece.line, length).point));
      const startIsStop =
        piece.startAtJunction ||
        (piece.startVertexM < 1e-6 && !onBoundary(pointAlong(piece.line, 0).point));
      for (const lane of turning) {
        const forward = lane.dir === "fw";
        if (forward ? !endIsStop : !startIsStop) continue;
        const glyph = glyphUnion(lane.turn ?? []);
        for (const offset of OFFSETS_M) {
          if (available < (offset === 4 ? FIRST_NEEDS_M : SECOND_NEEDS_M)) continue;
          const along = forward
            ? piece.endM - offset - ARROW_HALF_LENGTH
            : piece.startM + offset + ARROW_HALF_LENGTH;
          const { point, dir } = pointAlong(piece.line, along);
          const centre: Pt = [point[0] - dir[1] * lane.offset, point[1] + dir[0] * lane.offset];
          const axis: Pt = forward ? dir : [-dir[0], -dir[1]];
          rings.push(...transformTemplate(glyph, centre, axis, 1));
        }
      }
    }
    if (rings.length > 0) out.push({ kind: "arrow", layer: layerOf(road.props), rings });
  });
  return out;
}
