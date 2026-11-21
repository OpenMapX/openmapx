/** murmur3's 32-bit finaliser. */
function mix(value: number): number {
  let h = value;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * A fixed 32-bit unsigned hash of an integer cell (i, j). World-anchored
 * placement (forest jitter, tree variants) depends on it never changing.
 */
export function hash2(i: number, j: number): number {
  return mix(0x9e3779b9 ^ Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(mix(j | 0), 0x165667b1));
}

/** The k-th independent value in [0, 1) drawn from a hash. */
export function unit(h: number, k: number): number {
  return mix(h ^ Math.imul(k + 1, 0x9e3779b1)) / 4294967296;
}
