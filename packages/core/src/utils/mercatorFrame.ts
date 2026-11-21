/**
 * Frame maths for three.js custom layers drawn inside MapLibre. The scene is
 * right-handed metres relative to a per-frame origin: x east, y north, z up.
 * Mercator's y points south, so that reflection lives in the camera matrix and
 * object matrices stay proper rotations. Plain maths, no `maplibre-gl` import,
 * so workers and tests can use it.
 */

/** MapLibre's Earth circumference (radius 6371008.8 m). */
export const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * 6371008.8;

/** Column-major 4×4 matrix in float64. */
export type Matrix4 = Float64Array;

/** A Web Mercator point (0..1) and the size of one metre there in mercator units. */
export interface MercatorOrigin {
  x: number;
  y: number;
  metersToUnits: number;
}

export function mercatorOrigin(lng: number, lat: number): MercatorOrigin {
  return {
    x: (lng + 180) / 360,
    y: (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360,
    metersToUnits: 1 / (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)),
  };
}

export function multiply4(a: ArrayLike<number>, b: ArrayLike<number>): Matrix4 {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + row] as number) * (b[col * 4 + k] as number);
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

export function translation4(x: number, y: number, z: number): Matrix4 {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

export function scaling4(x: number, y: number, z: number): Matrix4 {
  return new Float64Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
}

/**
 * The three.js camera's projection: MapLibre's `mainMatrix` (mercator 0..1 to
 * clip space), moved to the origin and scaled from scene metres, composed in
 * float64 so street-level precision survives the upload as float32.
 */
export function cameraMatrix(mainMatrix: ArrayLike<number>, origin: MercatorOrigin): Matrix4 {
  const s = origin.metersToUnits;
  return multiply4(multiply4(mainMatrix, translation4(origin.x, origin.y, 0)), scaling4(s, -s, s));
}

/**
 * Place a model in scene space. `baseM` is the height of the model's ground
 * above sea level. The uniform scale corrects the mercator scale between the
 * anchor's and the origin's latitude; `post` (for example a model-axis
 * rotation) is applied first.
 */
export function objectMatrix(
  anchor: readonly [number, number],
  baseM: number,
  origin: MercatorOrigin,
  post?: ArrayLike<number>,
): Matrix4 {
  const at = mercatorOrigin(anchor[0], anchor[1]);
  const s = origin.metersToUnits;
  const k = at.metersToUnits / s;
  const placed = multiply4(
    translation4((at.x - origin.x) / s, -(at.y - origin.y) / s, baseM * k),
    scaling4(k, k, k),
  );
  return post ? multiply4(placed, post) : placed;
}

/**
 * Write one instance matrix (column-major float32) at `offset`: scale, then a
 * rotation by `headingRad` about the vertical (counter-clockwise from east),
 * then a translation to (xM, yM, zM) in scene metres.
 */
export function instanceMatrix(
  out: Float32Array,
  offset: number,
  xM: number,
  yM: number,
  zM: number,
  headingRad: number,
  scaleXY: number,
  scaleZ: number,
): void {
  const c = Math.cos(headingRad) * scaleXY;
  const s = Math.sin(headingRad) * scaleXY;
  out[offset] = c;
  out[offset + 1] = s;
  out[offset + 2] = 0;
  out[offset + 3] = 0;
  out[offset + 4] = -s;
  out[offset + 5] = c;
  out[offset + 6] = 0;
  out[offset + 7] = 0;
  out[offset + 8] = 0;
  out[offset + 9] = 0;
  out[offset + 10] = scaleZ;
  out[offset + 11] = 0;
  out[offset + 12] = xM;
  out[offset + 13] = yM;
  out[offset + 14] = zM;
  out[offset + 15] = 1;
}
