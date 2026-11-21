import type { TileFeature } from "./decode";
import {
  convexHull,
  minAreaRect,
  type Pt,
  type Ring,
  ringArea,
  transformTemplate,
} from "./geometry";
import {
  basketballLines,
  soccerLines,
  strokeLines,
  TENNIS_LENGTH_M,
  TENNIS_WIDTH_M,
  tennisLines,
} from "./pitch-templates";
import type { PaintPolygon } from "./roads";
import { firstSport } from "./validate";

export { basketballLines, PITCH_TEMPLATES, soccerLines } from "./pitch-templates";

/** Pitch markings fitted to mapped pitch polygons (spec §5.7). Metres in the tile frame. */

const MIN_FILL = 0.85;
const MIN_SHORT_SIDE_M = 10;
const COURT_GAP_M = 4;
const OTHER_INSET_M = 1;

/**
 * Court centre offsets across the pitch: one regulation court when the pitch
 * is at least 0.9 × the court and narrower than 1.8 courts, several side by
 * side with 4 m gaps when two or more fit across, otherwise none.
 */
export function tennisLayout(length: number, width: number): number[] | null {
  if (length < 0.9 * TENNIS_LENGTH_M || width < 0.9 * TENNIS_WIDTH_M) return null;
  const count = Math.floor((width + COURT_GAP_M) / (TENNIS_WIDTH_M + COURT_GAP_M));
  if (count >= 2) {
    const span = count * TENNIS_WIDTH_M + (count - 1) * COURT_GAP_M;
    return Array.from(
      { length: count },
      (_, i) => -span / 2 + TENNIS_WIDTH_M / 2 + i * (TENNIS_WIDTH_M + COURT_GAP_M),
    );
  }
  return width < 1.8 * TENNIS_WIDTH_M ? [0] : null;
}

function insetBoundary(length: number, width: number): Pt[][] {
  const halfL = length / 2 - OTHER_INSET_M;
  const halfW = width / 2 - OTHER_INSET_M;
  if (halfL <= 0 || halfW <= 0) return [];
  return [
    [
      [-halfW, -halfL],
      [halfW, -halfL],
      [halfW, halfL],
      [-halfW, halfL],
      [-halfW, -halfL],
    ],
  ];
}

/** Template lines for a sport on a fitted `length` × `width` rectangle. */
function linesFor(sport: string | null, length: number, width: number): Pt[][] {
  if (sport === "soccer") return Object.values(soccerLines(length, width)).flat();
  if (sport === "tennis") {
    const offsets = tennisLayout(length, width);
    return (offsets ?? []).flatMap((u0) =>
      tennisLines().map((line) => line.map(([u, v]): Pt => [u + u0, v])),
    );
  }
  if (sport === "basketball") return basketballLines(length, width);
  return insetBoundary(length, width);
}

/** The outer ring with the largest area and the holes that follow it (MVT winding). */
function outerAndArea(rings: Pt[][]): { outer: Pt[]; area: number } | null {
  let best: { outer: Pt[]; area: number } | null = null;
  let current: { outer: Pt[]; area: number } | null = null;
  for (const ring of rings) {
    const area = ringArea(ring);
    if (area > 0) {
      current = { outer: ring, area };
      if (!best || area > best.area) best = current;
    } else if (current) {
      current.area += area;
    }
  }
  return best;
}

/**
 * Fit each pitch's minimum-area rectangle and draw its sport's markings;
 * pitches filling less than 85 % of the rectangle or narrower than 10 m are
 * skipped. One paint polygon per pitch.
 */
export function pitchPaint(pitches: TileFeature[], mpu: number): PaintPolygon[] {
  const out: PaintPolygon[] = [];
  for (const pitch of pitches) {
    if (pitch.type !== 3) continue;
    const metres = pitch.geometry.map((ring) => ring.map(([x, y]): Pt => [x * mpu, y * mpu]));
    const shape = outerAndArea(metres);
    if (!shape) continue;
    const rect = minAreaRect(convexHull(shape.outer));
    if (rect.width < MIN_SHORT_SIDE_M || shape.area / (rect.length * rect.width) < MIN_FILL)
      continue;
    // Both tiles that see a pitch must draw it identically: fix the axis sign.
    const axis: Pt =
      rect.axis[1] < 0 || (rect.axis[1] === 0 && rect.axis[0] < 0)
        ? [-rect.axis[0], -rect.axis[1]]
        : rect.axis;
    const lines = linesFor(firstSport(pitch.props.sport), rect.length, rect.width);
    const rings: Ring[] = transformTemplate(strokeLines(lines), rect.centre, axis, 1);
    if (rings.length > 0) out.push({ kind: "pitch", layer: 0, rings });
  }
  return out;
}
