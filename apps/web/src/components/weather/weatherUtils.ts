const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export function windDirectionLabel(deg: number): string {
  const label = DIRS[((Math.round(deg / 45) % 8) + 8) % 8];
  // Only a non-finite bearing has no compass point.
  if (label === undefined) throw new RangeError(`No compass point for ${deg}°`);
  return label;
}
