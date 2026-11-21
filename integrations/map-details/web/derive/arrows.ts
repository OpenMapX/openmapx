import type { TileFeature } from "./decode";
import { type Pt, pointAlong, polylineLength, type Ring, transformTemplate } from "./geometry";
import type { RoadPiece } from "./lanes";
import { type CrossSection, isMotorRoad, layerOf, type PaintPolygon } from "./roads";

/**
 * Turn arrows from valid `turn:lanes*` lists (spec §5.3). Glyphs are metre
 * templates 5 m long and 1.2 m wide, centred, pointing +y (forward), with +x
 * to the right of travel.
 */

const rect = (u0: number, v0: number, u1: number, v1: number): Ring => [
  [u0, v0],
  [u1, v0],
  [u1, v1],
  [u0, v1],
];
const mirror = (rings: Ring[]): Ring[] =>
  rings.map((ring) => ring.map(([u, v]): Pt => [-u, v]).reverse());

const LEFT: Ring[] = [
  rect(0.15, -2.5, 0.45, 2.35),
  rect(-0.15, 2.05, 0.45, 2.35),
  [
    [-0.15, 1.9],
    [-0.15, 2.5],
    [-0.6, 2.2],
  ],
];
const SLIGHT_LEFT: Ring[] = [
  rect(0.15, -2.5, 0.45, 0.5),
  [
    [0.15, 0.5],
    [0.45, 0.5],
    [0.05, 1.6],
    [-0.25, 1.6],
  ],
  [
    [-0.6, 1.4],
    [0.25, 1.7],
    [-0.45, 2.5],
  ],
];
const SHARP_LEFT: Ring[] = [
  rect(0.15, -2.5, 0.45, 2.5),
  [
    [0.15, 2.5],
    [0.15, 2.15],
    [-0.3, 1.45],
    [-0.3, 1.8],
  ],
  [
    [-0.6, 1.0],
    [-0.45, 1.95],
    [-0.05, 1.45],
  ],
];
const MERGE_TO_LEFT: Ring[] = [
  [
    [0.15, -2.5],
    [0.45, -2.5],
    [-0.15, 1.0],
    [-0.45, 1.0],
  ],
  [
    [-0.6, 1.0],
    [0, 1.0],
    [-0.3, 2.5],
  ],
];

export const ARROW_GLYPHS: Record<string, Ring[]> = {
  through: [
    rect(-0.15, -2.5, 0.15, 1.0),
    [
      [-0.6, 1.0],
      [0.6, 1.0],
      [0, 2.5],
    ],
  ],
  left: LEFT,
  right: mirror(LEFT),
  slight_left: SLIGHT_LEFT,
  slight_right: mirror(SLIGHT_LEFT),
  sharp_left: SHARP_LEFT,
  sharp_right: mirror(SHARP_LEFT),
  reverse: [
    rect(0.15, -2.5, 0.45, 2.5),
    rect(-0.45, 2.2, 0.45, 2.5),
    rect(-0.45, 0.5, -0.15, 2.5),
    [
      [-0.6, 0.5],
      [0, 0.5],
      [-0.3, -0.3],
    ],
  ],
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
