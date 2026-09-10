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

export function spaceOpacity(zoom: number, globeTransition: number): number {
  // Lose the stars gradually as the atmosphere fills the view, before the
  // globe preset becomes Mercator. No independent time-based animation.
  const t = Math.max(0, Math.min(1, (zoom - 4) / 4));
  return Math.max(0, Math.min(1, globeTransition)) * (1 - t * t * (3 - 2 * t));
}

export const STAR_COUNT = 12_000;
export const STAR_STRIDE = 6;

/** A deterministic, uniformly sampled sphere, not a repeating screen tile. */
export function createStarCatalog(): Float32Array {
  let seed = 42;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const stars = new Float32Array(STAR_COUNT * STAR_STRIDE);
  for (let i = 0; i < STAR_COUNT; i++) {
    const y = random() * 2 - 1;
    const longitude = random() * Math.PI * 2;
    const radius = Math.sqrt(1 - y * y);
    const brightness = random() ** 5;
    stars.set(
      [
        Math.sin(longitude) * radius,
        y,
        Math.cos(longitude) * radius,
        1.2 + brightness * 3.8,
        0.18 + brightness * 0.72,
        random(),
      ],
      i * STAR_STRIDE,
    );
  }
  return stars;
}
