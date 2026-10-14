import { type Geom, intersection } from "polyclip-ts";
import type { MultiPolygon, Ring } from "./nativeRasterCoverage";

/** Dyadic world coordinates retain exact sibling/ancestor seams before projection. */
export function retainedTileDomain(coord: {
  wrap: number;
  canonical: { z: number; x: number; y: number };
}): MultiPolygon {
  const scale = 2 ** coord.canonical.z;
  const x = coord.wrap + coord.canonical.x / scale,
    y = coord.canonical.y / scale,
    d = 1 / scale;
  return [
    [
      [
        [x, y],
        [x + d, y],
        [x + d, y + d],
        [x, y + d],
        [x, y],
      ],
    ],
  ];
}
/** One renderer frame projection for the merged planar domain. Tile-specific
 * float32 translations must not introduce artificial cracks along internal seams.
 * Frustum clipping is performed in world space, before perspective division. */
export function projectMercatorMask(
  mask: MultiPolygon,
  matrix: ArrayLike<number>,
  wrap: number,
  width: number,
  height: number,
): MultiPolygon | undefined {
  if (!mask.length) return [];
  if (matrix.length !== 16 || Array.from(matrix).some((n) => !Number.isFinite(n))) return undefined;
  const project = (x: number, y: number) => {
    const tx = (x - wrap) * 8192,
      ty = y * 8192;
    return [0, 1, 2, 3].map((i) => matrix[i] * tx + matrix[i + 4] * ty + matrix[i + 12]);
  };
  const points = mask.flat(2);
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  let clip: Ring = [
    [Math.min(...xs), Math.min(...ys)],
    [Math.max(...xs), Math.min(...ys)],
    [Math.max(...xs), Math.max(...ys)],
    [Math.min(...xs), Math.max(...ys)],
  ];
  for (const [axis, sign] of [
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [2, 1],
    [2, -1],
  ]) {
    const result: Ring = [];
    for (let i = 0; i < clip.length; i++) {
      const a = clip[i],
        b = clip[(i + 1) % clip.length],
        pa = project(...a),
        pb = project(...b);
      const da = pa[3] + sign * pa[axis],
        db = pb[3] + sign * pb[axis];
      if (da >= 0) result.push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        result.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      }
    }
    clip = result;
  }
  if (clip.length < 3) return [];
  clip.push(clip[0]);
  const clipped = intersection(mask, [clip] as Geom);
  // Normalize only the known frustum boundary's floating arithmetic (not tile
  // seams or internal holes). This is bounded double-precision roundoff in CSS
  // pixels; it does not coarsen disconnected exposure to meet a query budget.
  const boundary = (n: number, max: number) => {
    const error = Number.EPSILON * Math.max(width, height) * 256;
    return Math.abs(n) < error ? 0 : Math.abs(n - max) < error ? max : n;
  };
  const output: MultiPolygon = [];
  for (const polygon of clipped) {
    const rings: Ring[] = [];
    for (const ring of polygon) {
      const projected: Ring = [];
      for (const point of ring) {
        const p = project(...point);
        if (p[3] <= 0) return undefined;
        projected.push([
          boundary(((p[0] / p[3] + 1) * width) / 2, width),
          boundary(((1 - p[1] / p[3]) * height) / 2, height),
        ]);
      }
      rings.push(projected);
    }
    output.push(rings);
  }
  return output;
}
