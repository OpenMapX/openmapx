import type { MultiPolygon } from "./nativeRasterCoverage";

type Rectangle = readonly [number, number, number, number];
type Edge = readonly [number, number, number, number];
/** Exact fast path for the orthogonal dyadic raster union. A rectangle is
 * contained iff its interior sample is filled and no union boundary crosses
 * its open interior. Holes and concave/disconnected boundaries are retained;
 * an unsupported edge falls through to the ordinary polygon subtraction. */
export function prepareRasterContainment(mask: MultiPolygon): (rectangle: Rectangle) => boolean {
  const edges: Edge[] = [];
  for (const polygon of mask)
    for (const ring of polygon)
      for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1],
          b = ring[i];
        if (
          a.some((n) => !Number.isFinite(n)) ||
          b.some((n) => !Number.isFinite(n)) ||
          (a[0] !== b[0] && a[1] !== b[1])
        )
          return () => false;
        edges.push([a[0], a[1], b[0], b[1]]);
      }
  return ([left, top, right, bottom]) => {
    if (!(left < right && top < bottom)) return false;
    const x = (left + right) / 2,
      y = (top + bottom) / 2;
    let inside = false;
    for (const [ax, ay, bx, by] of edges) {
      if (ax === bx) {
        if (ax > left && ax < right && Math.max(ay, by) > top && Math.min(ay, by) < bottom)
          return false;
        if (ay > y !== by > y && ax > x) inside = !inside;
      } else if (ay > top && ay < bottom && Math.max(ax, bx) > left && Math.min(ax, bx) < right)
        return false;
    }
    return inside;
  };
}
export function tileRectangleInWorld(
  coordinate: { wrap: number; canonical: { z: number; x: number; y: number } },
  bounds: Rectangle,
): Rectangle {
  const scale = 2 ** coordinate.canonical.z;
  const { x, y } = coordinate.canonical;
  return [
    coordinate.wrap + (x + bounds[0] / 8192) / scale,
    (y + bounds[1] / 8192) / scale,
    coordinate.wrap + (x + bounds[2] / 8192) / scale,
    (y + bounds[3] / 8192) / scale,
  ];
}
