import { MercatorCoordinate } from "maplibre-gl";

/**
 * Landmark GLBs use X east, Y up, Z south, in metres, with the origin on the
 * ground at the anchor. The scene they are drawn in is right-handed metres
 * relative to a per-frame origin: x east, y north, z up. Mercator's y points
 * south, so that reflection lives in the camera matrix; object matrices stay
 * proper rotations, which keeps three.js's face culling and normals right.
 */

/** Column-major 4×4 rotation taking (X, Y, Z) of the GLB frame to (X, −Z, Y). */
export const GLB_TO_SCENE: readonly number[] = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

type Matrix = Float64Array;

function multiply(a: ArrayLike<number>, b: ArrayLike<number>): Matrix {
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

function translation(x: number, y: number, z: number): Matrix {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

function scaling(x: number, y: number, z: number): Matrix {
  return new Float64Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
}

/**
 * The three.js camera's projection: MapLibre's `mainMatrix` (mercator 0..1 to
 * clip space), moved to the origin and scaled from scene metres, composed in
 * float64 so street-level precision survives the upload as float32.
 */
export function cameraMatrix(mainMatrix: ArrayLike<number>, origin: MercatorCoordinate): Matrix {
  const s = origin.meterInMercatorCoordinateUnits();
  return multiply(multiply(mainMatrix, translation(origin.x, origin.y, 0)), scaling(s, -s, s));
}

/**
 * Place a model in scene space. `baseM` is the height of the model's ground
 * above sea level. The uniform scale corrects the mercator scale between the
 * anchor's and the origin's latitude.
 */
export function objectMatrix(
  anchor: readonly [number, number],
  baseM: number,
  origin: MercatorCoordinate,
): Matrix {
  const at = MercatorCoordinate.fromLngLat([anchor[0], anchor[1]]);
  const s = origin.meterInMercatorCoordinateUnits();
  const k = at.meterInMercatorCoordinateUnits() / s;
  return multiply(
    multiply(
      translation((at.x - origin.x) / s, -(at.y - origin.y) / s, baseM * k),
      scaling(k, k, k),
    ),
    GLB_TO_SCENE,
  );
}

type Tuple16 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** Inverse of a column-major 4×4 matrix (gl-matrix's cofactor expansion), or null if singular. */
function invert(m: ArrayLike<number>): Matrix | null {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] =
    Array.from(m) as Tuple16;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (det === 0 || !Number.isFinite(det)) return null;
  const d = 1 / det;
  return new Float64Array([
    (a11 * b11 - a12 * b10 + a13 * b09) * d,
    (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d,
    (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d,
    (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d,
    (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d,
    (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d,
    (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d,
    (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d,
    (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ]);
}

function transformPoint(
  m: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  const out = [0, 0, 0, 0];
  for (let row = 0; row < 4; row++)
    out[row] =
      (m[row] as number) * x +
      (m[4 + row] as number) * y +
      (m[8 + row] as number) * z +
      (m[12 + row] as number);
  const w = out[3] as number;
  return [(out[0] as number) / w, (out[1] as number) / w, (out[2] as number) / w];
}

/**
 * The scene-space ray under a canvas pixel, for picking. three.js's
 * `Raycaster.setFromCamera` assumes its own camera conventions, which do not
 * hold for a projection baked from MapLibre's matrix.
 */
export function unprojectRay(
  camera: ArrayLike<number>,
  point: { x: number; y: number },
  viewport: { width: number; height: number },
): { origin: [number, number, number]; direction: [number, number, number] } {
  const inverse = invert(camera);
  const ndcX = (point.x / viewport.width) * 2 - 1;
  const ndcY = 1 - (point.y / viewport.height) * 2;
  if (!inverse) return { origin: [0, 0, 0], direction: [0, 0, -1] };
  const near = transformPoint(inverse, ndcX, ndcY, -1);
  const far = transformPoint(inverse, ndcX, ndcY, 1);
  const d = [far[0] - near[0], far[1] - near[1], far[2] - near[2]];
  const length = Math.hypot(d[0] as number, d[1] as number, d[2] as number) || 1;
  return {
    origin: near,
    direction: [(d[0] as number) / length, (d[1] as number) / length, (d[2] as number) / length],
  };
}
