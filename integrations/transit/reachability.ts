import { createHash } from "node:crypto";
import { toWebMercator } from "@openmapx/mobility-core/mercator";
import type {
  TransitReachabilityCheckRequest,
  TransitReachabilitySeed,
  TransitReachabilitySurface,
  TransitReachabilitySurfaceRequest,
} from "@openmapx/mobility-core/transit-reachability";

export const INITIAL_TRANSIT_SEED_GRID_METRES = 100;
export const MAX_TRANSIT_REACHABILITY_SEEDS = 4_096;

function preferSeed(
  a: TransitReachabilitySeed,
  b: TransitReachabilitySeed,
): TransitReachabilitySeed {
  if (a.arrivalSeconds !== b.arrivalSeconds) return a.arrivalSeconds < b.arrivalSeconds ? a : b;
  if (a.lng !== b.lng) return a.lng < b.lng ? a : b;
  return a.lat <= b.lat ? a : b;
}

function thinAtGrid(seeds: readonly TransitReachabilitySeed[], gridMetres: number) {
  const cells = new Map<string, TransitReachabilitySeed>();
  for (const seed of seeds) {
    const [x, y] = toWebMercator(seed.lng, seed.lat);
    const key = `${Math.floor(x / gridMetres)}:${Math.floor(y / gridMetres)}`;
    const current = cells.get(key);
    cells.set(key, current ? preferSeed(current, seed) : seed);
  }
  return [...cells.values()].sort(
    (a, b) => a.arrivalSeconds - b.arrivalSeconds || a.lng - b.lng || a.lat - b.lat,
  );
}

export function thinTransitReachabilitySurface(
  surface: TransitReachabilitySurface,
): TransitReachabilitySurface {
  const originalSeedCount = surface.seeds.length;
  let gridMetres = INITIAL_TRANSIT_SEED_GRID_METRES;
  let seeds = thinAtGrid(surface.seeds, gridMetres);
  while (seeds.length > MAX_TRANSIT_REACHABILITY_SEEDS) {
    gridMetres *= 2;
    seeds = thinAtGrid(surface.seeds, gridMetres);
  }
  return {
    ...surface,
    seeds,
    thinning: { originalSeedCount, seedCount: seeds.length, gridMetres },
  };
}

function normalizedQuery(request: TransitReachabilitySurfaceRequest) {
  return {
    origin: {
      lng: Number(request.origin.lng.toFixed(5)),
      lat: Number(request.origin.lat.toFixed(5)),
    },
    queryTime: request.queryTime,
    thresholdsMinutes: request.thresholdsMinutes,
    transitModes: request.transitModes ?? [],
    walkProfileId: request.walkProfileId,
    direction: request.direction,
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function transitSurfaceCacheKey(
  request: TransitReachabilitySurfaceRequest,
  datasetEpoch: string | null,
): string {
  return `reachability:surface:${datasetEpoch ?? "unknown"}:${hash(normalizedQuery(request))}`;
}

export function transitCheckCacheKey(
  request: TransitReachabilityCheckRequest,
  datasetEpoch: string | null,
): string {
  return `reachability:check:${datasetEpoch ?? "unknown"}:${hash({
    ...normalizedQuery(request),
    destinations: request.destinations.map(({ id, lng, lat }) => ({
      id,
      lng: Number(lng.toFixed(5)),
      lat: Number(lat.toFixed(5)),
    })),
  })}`;
}
