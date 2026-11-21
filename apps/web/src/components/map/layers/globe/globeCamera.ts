/**
 * Camera helpers for drawing in MapLibre's globe frame, where the planet is the
 * unit sphere and the render input's model-view-projection matrix maps that
 * sphere to clip space.
 */

/**
 * Project celestial directions through the globe's camera. Keep the x/y/w rows
 * and discard translation: stars are effectively at infinity, so orbit/tilt
 * changes their view, but a dolly toward Earth produces no stellar parallax.
 *
 * Using the render input (rather than reconstructing a camera from lng/lat)
 * also preserves bearing, roll, field of view and asymmetric map padding.
 */
export function skyProjectionMatrix(matrix: ArrayLike<number>, out = new Float32Array(9)) {
  const scale = Math.hypot(matrix[3], matrix[7], matrix[11]);
  for (let column = 0; column < 3; column++) {
    out[column * 3] = matrix[column * 4] / scale;
    out[column * 3 + 1] = matrix[column * 4 + 1] / scale;
    out[column * 3 + 2] = matrix[column * 4 + 3] / scale;
  }
  return out;
}

/**
 * Invert a column-major 4×4 matrix in double precision. The globe matrix maps a
 * unit sphere to a screen thousands of pixels wide, so a single-precision
 * inverse would lose the sphere's edge. Returns `null` for a singular matrix.
 */
export function invertMatrix(
  m: ArrayLike<number>,
  out = new Float64Array(16),
): Float64Array | null {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] =
    Array.from({ length: 16 }, (_, i) => m[i]);
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
  const determinant = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!determinant || !Number.isFinite(determinant)) return null;
  const d = 1 / determinant;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return out;
}

/**
 * The camera's position in the globe frame. Every clip-space point with w = 0
 * on the view axis unprojects to the eye, so it is the inverse's third column
 * divided by its w.
 */
export function cameraPosition(inverse: ArrayLike<number>, out = new Float32Array(3)) {
  out[0] = inverse[8] / inverse[11];
  out[1] = inverse[9] / inverse[11];
  out[2] = inverse[10] / inverse[11];
  return out;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function clampTransition(transition: number): number {
  return Math.max(0, Math.min(1, transition));
}

/**
 * How much of the background is space rather than the theme's sky colour. Fully
 * space up to zoom 5, the theme's sky again from zoom 8, where the product
 * looks as it did before the globe had a sky of its own.
 */
export function spaceAmount(zoom: number, transition: number): number {
  return clampTransition(transition) * (1 - smoothstep(5, 8, zoom));
}

/** Strength of the glow, day and night shading, city lights and the Sun. */
export function surfaceFade(zoom: number, transition: number): number {
  return clampTransition(transition) * (1 - smoothstep(5, 7, zoom));
}
