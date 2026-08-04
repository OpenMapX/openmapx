import type * as MapLibre from "maplibre-gl";

export type MapLibreRuntime = typeof MapLibre;

const MAPLIBRE_RUNTIME_BASE = "/runtime/maplibre-gl";

export function mapLibreWorkerUrl(maplibre: MapLibreRuntime): string {
  return `${MAPLIBRE_RUNTIME_BASE}/${maplibre.getVersion()}/maplibre-gl-worker.mjs`;
}

/**
 * MapLibre 6 resolves its split ESM worker relative to `import.meta.url`.
 * Turbopack rewrites that URL to a hashed asset without preserving the
 * worker's relative shared-module names, so the derived worker cannot start.
 * Always point MapLibre at the version-matched pair copied to `public/runtime`.
 */
export function configureMapLibreRuntime(maplibre: MapLibreRuntime): MapLibreRuntime {
  const workerUrl = mapLibreWorkerUrl(maplibre);
  if (maplibre.getWorkerUrl() !== workerUrl) maplibre.setWorkerUrl(workerUrl);
  return maplibre;
}

export async function loadMapLibreRuntime(): Promise<MapLibreRuntime> {
  return configureMapLibreRuntime(await import("maplibre-gl"));
}
