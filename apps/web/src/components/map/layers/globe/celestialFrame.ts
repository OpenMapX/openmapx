import { greenwichSiderealAngle } from "./sunPosition";

/**
 * Rows of the IAU rotation from J2000 equatorial to galactic coordinates:
 * galactic +x points at the Galactic Centre, +z at the north galactic pole.
 */
const EQUATORIAL_TO_GALACTIC = [
  [-0.0548755604, -0.8734370902, -0.4838350155],
  [0.4941094279, -0.44482963, 0.7469822445],
  [-0.867666149, -0.1980763734, 0.4559837762],
] as const;

/**
 * Column-major 3×3 rotation from the Earth-fixed globe frame to the galactic
 * frame at the given instant. A star's right ascension equals its Earth-fixed
 * longitude plus the sidereal angle, so the sky turns once per sidereal day.
 * The Milky Way texture is sampled in the galactic frame, and the stars are
 * placed with the transpose so both stay fixed against each other.
 */
export function galacticRotation(date: Date, out = new Float32Array(9)): Float32Array {
  const angle = greenwichSiderealAngle(date);
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  // Equatorial x = cos θ·z − sin θ·x, equatorial y = cos θ·x + sin θ·z and
  // equatorial z = y, in globe-frame components.
  EQUATORIAL_TO_GALACTIC.forEach(([toX, toY, toZ], row) => {
    out[row] = -toX * sin + toY * cos;
    out[row + 3] = toZ;
    out[row + 6] = toX * cos + toY * sin;
  });
  return out;
}
