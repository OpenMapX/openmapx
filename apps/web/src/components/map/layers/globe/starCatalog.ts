export const STAR_COUNT = 12_000;
/** Direction (xyz), point size, alpha and colour temperature per star. */
export const STAR_STRIDE = 6;

/**
 * A deterministic, uniformly sampled sphere of stars in the galactic frame,
 * not a repeating screen tile.
 */
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
