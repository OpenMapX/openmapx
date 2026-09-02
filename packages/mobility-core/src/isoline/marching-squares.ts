import type { IsochroneLattice } from "./lattice.js";

type Point = [number, number];

/** A lattice corner is "inside" when it is reachable within the threshold. */
function inside(value: number | null, threshold: number): boolean {
  return value !== null && value <= threshold;
}

/**
 * Where the contour crosses the segment between two lattice corners.
 *
 * Linear interpolation is only defined when both endpoints carry a real travel
 * time. When one endpoint is unreachable there is no gradient to interpolate
 * along, so the crossing goes to the midpoint: any other choice would invent a
 * boundary position out of a sentinel's magnitude.
 */
function crossingFraction(a: number | null, b: number | null, threshold: number): number {
  if (a === null || b === null) return 0.5;
  const span = b - a;
  if (span === 0) return 0.5;
  return Math.min(1, Math.max(0, (threshold - a) / span));
}

/**
 * Trace closed contour rings of `{ value <= thresholdSeconds }`.
 *
 * Segments are emitted per cell and then stitched into rings, which keeps the
 * cell logic free of any global traversal state. Coordinates are Web Mercator
 * metres; the caller unprojects.
 */
export function traceContourRings(
  field: readonly (number | null)[],
  lattice: IsochroneLattice,
  thresholdSeconds: number,
): Point[][] {
  const { nx, ny, originX, originY, spacing } = lattice;
  if (field.length !== nx * ny) {
    throw new RangeError(`field length ${field.length} does not match lattice ${nx}x${ny}`);
  }

  // The lattice is walked with one ring of virtual unreachable points around
  // it. A contour that reaches the sampled edge then closes against that border
  // instead of running off as an open chain the stitcher would have to discard —
  // which would silently drop the entire polygon whenever the reachable area
  // extends past the requested bbox, the common case for a wide time budget.
  const valueAt = (column: number, row: number): number | null =>
    column < 0 || column >= nx || row < 0 || row >= ny ? null : field[row * nx + column];
  const pointX = (column: number) => originX + column * spacing;
  const pointY = (row: number) => originY + row * spacing;
  const segments: Array<[Point, Point]> = [];

  for (let row = -1; row < ny; row += 1) {
    for (let column = -1; column < nx; column += 1) {
      const sw = valueAt(column, row);
      const se = valueAt(column + 1, row);
      const ne = valueAt(column + 1, row + 1);
      const nw = valueAt(column, row + 1);

      const code =
        (inside(sw, thresholdSeconds) ? 1 : 0) |
        (inside(se, thresholdSeconds) ? 2 : 0) |
        (inside(ne, thresholdSeconds) ? 4 : 0) |
        (inside(nw, thresholdSeconds) ? 8 : 0);
      if (code === 0 || code === 15) continue;

      const bottom = (): Point => [
        pointX(column) + crossingFraction(sw, se, thresholdSeconds) * spacing,
        pointY(row),
      ];
      const right = (): Point => [
        pointX(column + 1),
        pointY(row) + crossingFraction(se, ne, thresholdSeconds) * spacing,
      ];
      const top = (): Point => [
        pointX(column) + crossingFraction(nw, ne, thresholdSeconds) * spacing,
        pointY(row + 1),
      ];
      const left = (): Point => [
        pointX(column),
        pointY(row) + crossingFraction(sw, nw, thresholdSeconds) * spacing,
      ];

      // Saddles (5 and 10) are ambiguous. Disambiguate on the mean of the
      // corners; if any corner is unreachable, resolve as separated so the
      // contour never bridges what is probably a barrier.
      const saddleJoined = (): boolean => {
        const corners = [sw, se, ne, nw];
        if (corners.some((corner) => corner === null)) return false;
        const mean = (corners as number[]).reduce((sum, value) => sum + value, 0) / 4;
        return mean <= thresholdSeconds;
      };

      // Directions matter: a case and its complement (code and 15-code) trace
      // the same cut but must run opposite ways, so that adjacent cells meet
      // head-to-tail and the stitcher can chain them into a ring. Emitting both
      // members of a pair in the same direction produces segments that never
      // join and therefore no rings at all.
      switch (code) {
        case 1:
          segments.push([left(), bottom()]);
          break;
        case 14:
          segments.push([bottom(), left()]);
          break;
        case 2:
          segments.push([bottom(), right()]);
          break;
        case 13:
          segments.push([right(), bottom()]);
          break;
        case 3:
          segments.push([left(), right()]);
          break;
        case 12:
          segments.push([right(), left()]);
          break;
        case 4:
          segments.push([right(), top()]);
          break;
        case 11:
          segments.push([top(), right()]);
          break;
        case 6:
          segments.push([bottom(), top()]);
          break;
        case 9:
          segments.push([top(), bottom()]);
          break;
        case 7:
          segments.push([left(), top()]);
          break;
        case 8:
          segments.push([top(), left()]);
          break;
        case 5:
          // SW and NE inside. Separated bounds each inside corner on its own;
          // joined instead bounds the two outside corners, SE and NW.
          if (saddleJoined()) segments.push([right(), bottom()], [left(), top()]);
          else segments.push([left(), bottom()], [right(), top()]);
          break;
        case 10:
          // SE and NW inside; the mirror of case 5.
          if (saddleJoined()) segments.push([bottom(), left()], [top(), right()]);
          else segments.push([bottom(), right()], [top(), left()]);
          break;
        default:
          break;
      }
    }
  }

  return stitchRings(segments, spacing);
}

const KEY_PRECISION = 1e6;

function key(point: Point): string {
  return `${Math.round(point[0] * KEY_PRECISION)}:${Math.round(point[1] * KEY_PRECISION)}`;
}

/** Join shared endpoints into closed rings; open chains are closed explicitly. */
function stitchRings(segments: Array<[Point, Point]>, spacing: number): Point[][] {
  const starts = new Map<string, Array<[Point, Point]>>();
  for (const segment of segments) {
    const bucket = starts.get(key(segment[0]));
    if (bucket) bucket.push(segment);
    else starts.set(key(segment[0]), [segment]);
  }

  const used = new Set<[Point, Point]>();
  const rings: Point[][] = [];

  for (const segment of segments) {
    if (used.has(segment)) continue;
    used.add(segment);
    const ring: Point[] = [segment[0], segment[1]];

    // Follow shared endpoints until the chain closes or runs out. The guard
    // bounds the walk at the total segment count so a malformed field cannot
    // spin here.
    for (let guard = 0; guard <= segments.length; guard += 1) {
      const tail = ring[ring.length - 1];
      if (key(tail) === key(ring[0]) && ring.length > 2) break;
      const candidates = starts.get(key(tail)) ?? [];
      const next = candidates.find((candidate) => !used.has(candidate));
      if (!next) break;
      used.add(next);
      ring.push(next[1]);
    }

    if (ring.length < 4) continue;
    if (key(ring[0]) !== key(ring[ring.length - 1])) {
      // An open chain means the contour left the sampled bbox. Close it so the
      // ring is a valid polygon boundary; the clip is reported in metadata.
      const gap = Math.hypot(
        ring[0][0] - ring[ring.length - 1][0],
        ring[0][1] - ring[ring.length - 1][1],
      );
      if (gap > spacing * 4) continue;
      ring.push(ring[0]);
    }
    rings.push(ring);
  }

  return rings;
}
