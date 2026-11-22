/**
 * The navigation route as a lane-wide ribbon (immersive navigation spec §10.2):
 * never thinner than its pixel width, and as wide as one real lane once the map
 * is close enough for a lane to be wider than that.
 */

const EARTH_CIRCUMFERENCE_M = 40_075_016.7;
/** Zoom levels above the crossover the interpolation spans. */
const SPAN_ZOOMS = 6;

/** How many screen pixels `metres` covers at `latitude` and `zoom` (512 px tiles). */
export function metresToPixels(
  metres: number,
  latitude: number,
  zoom: number,
  tileSize = 512,
): number {
  const metresPerPixel =
    (EARTH_CIRCUMFERENCE_M * Math.cos((latitude * Math.PI) / 180)) / (tileSize * 2 ** zoom);
  return metres / metresPerPixel;
}

export type RouteWidthExpression = [
  "interpolate",
  ["exponential", number],
  ["zoom"],
  number,
  number,
  number,
  number,
];

/**
 * `basePx` until `metres` projects wider than that, then `metres` at real
 * scale. `offsetPx` is added at every zoom, so a casing stays exactly 3 px
 * wider than the line it frames: both stops share one exponential factor.
 */
export function routeWidthExpression(
  basePx: number,
  metres: number,
  latitude: number,
  offsetPx = 0,
): RouteWidthExpression {
  // The zoom at which `metres` covers `basePx`.
  const crossover = Math.log2(basePx / metresToPixels(metres, latitude, 0));
  return [
    "interpolate",
    ["exponential", 2],
    ["zoom"],
    crossover,
    basePx + offsetPx,
    crossover + SPAN_ZOOMS,
    basePx * 2 ** SPAN_ZOOMS + offsetPx,
  ];
}
