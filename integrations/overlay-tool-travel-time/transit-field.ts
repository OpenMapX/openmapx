import type { TransitReachabilitySeed } from "@openmapx/core";

export const TRANSIT_FIELD_WALK_SPEED_METRES_PER_SECOND = 1.2;
export const TRANSIT_FIELD_WALK_CAP_SECONDS = 900;
const EARTH_CIRCUMFERENCE_METRES = 40_075_016.686;

export interface TransitFieldInstance {
  x: number;
  y: number;
  radiusWorld: number;
  remainingSeconds: number;
  radiusSeconds: number;
}

export function normalizeTransitBands(minutes: readonly number[]): number[] {
  return [...new Set(minutes)]
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)
    .slice(0, 4);
}

export function seedRadiusMetres(
  seed: Pick<TransitReachabilitySeed, "arrivalSeconds">,
  maxBudgetSeconds: number,
): number {
  const remaining = Math.max(0, maxBudgetSeconds - seed.arrivalSeconds);
  return (
    Math.min(remaining, TRANSIT_FIELD_WALK_CAP_SECONDS) * TRANSIT_FIELD_WALK_SPEED_METRES_PER_SECOND
  );
}

export function mercatorWorld(lng: number, lat: number): [number, number] {
  const clamped = Math.max(-85.051_129, Math.min(85.051_129, lat));
  const x = (lng + 180) / 360;
  const sin = Math.sin((clamped * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  return [x, y];
}

export function metresToMercatorWorld(metres: number, lat: number): number {
  return metres / (EARTH_CIRCUMFERENCE_METRES * Math.cos((lat * Math.PI) / 180));
}

export function prepareTransitFieldInstances(
  seeds: readonly TransitReachabilitySeed[],
  maxBudgetSeconds: number,
): TransitFieldInstance[] {
  return seeds.flatMap((seed) => {
    const remainingSeconds = Math.max(0, maxBudgetSeconds - seed.arrivalSeconds);
    const radiusSeconds = Math.min(remainingSeconds, TRANSIT_FIELD_WALK_CAP_SECONDS);
    if (radiusSeconds <= 0) return [];
    const radiusMetres = radiusSeconds * TRANSIT_FIELD_WALK_SPEED_METRES_PER_SECOND;
    const [x, y] = mercatorWorld(seed.lng, seed.lat);
    return [
      {
        x,
        y,
        radiusWorld: metresToMercatorWorld(radiusMetres, seed.lat),
        remainingSeconds,
        radiusSeconds,
      },
    ];
  });
}
