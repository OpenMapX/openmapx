export interface WeightedBearing {
  /** Compass bearing in degrees. */
  bearing: number;
  weight: number;
}

export interface GridOrientation {
  /** Dominant axis folded into [0, 90). */
  bearing: number;
  /** Resultant length of the folded bearings, 0 (uniform) to 1 (all aligned). */
  confidence: number;
  /** Sum of the weights that contributed. */
  weight: number;
}

const FOLD = 4;
const DEG = Math.PI / 180;

/**
 * Circular mean of bearings folded modulo 90°, so a street and its cross
 * street (and either direction of travel) reinforce the same axis.
 */
export function dominantGridBearing(samples: readonly WeightedBearing[]): GridOrientation | null {
  let sin = 0;
  let cos = 0;
  let weight = 0;
  for (const sample of samples) {
    if (!(sample.weight > 0) || !Number.isFinite(sample.bearing)) continue;
    const theta = sample.bearing * DEG * FOLD;
    sin += sample.weight * Math.sin(theta);
    cos += sample.weight * Math.cos(theta);
    weight += sample.weight;
  }
  if (weight <= 0) return null;
  // Normalising twice keeps the result inside [0, 90): shifting a negative
  // angle by 90 can round up to exactly 90, which names the same axis as 0 but
  // sits 90° away from every neighbouring answer.
  const bearing = (((Math.atan2(sin, cos) / FOLD / DEG) % 90) + 90) % 90;
  return { bearing, confidence: Math.hypot(sin, cos) / weight, weight };
}

/** Signed rotation from `from` to `to`, in (−180, 180]. */
export function bearingDelta(from: number, to: number): number {
  const delta = (((to - from) % 360) + 360) % 360;
  return delta > 180 ? delta - 360 : delta;
}

/** The grid-aligned bearing reachable with the smallest rotation from `current`. */
export function nearestGridBearing(current: number, grid: number): number {
  let best = grid;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let k = 0; k < 4; k += 1) {
    const candidate = (((grid + 90 * k) % 360) + 360) % 360;
    const distance = Math.abs(bearingDelta(current, candidate));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}
