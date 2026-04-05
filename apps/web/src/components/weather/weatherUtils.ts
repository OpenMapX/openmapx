const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export function windDirectionLabel(deg: number): string {
  return DIRS[Math.round(deg / 45) % 8];
}
