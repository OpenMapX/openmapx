import { loadMapLibreRuntime } from "@/lib/maplibreRuntime";

const contourSources = new Map<string, Promise<string>>();

export async function contourDemTileUrl(
  tileTemplate: string,
  tilejsonUrl: string,
): Promise<string> {
  if (tileTemplate) return tileTemplate;
  const response = await fetch(tilejsonUrl);
  if (!response.ok) throw new Error("Terrain TileJSON unavailable");
  const tilejson = (await response.json()) as { tiles?: unknown };
  const tile = Array.isArray(tilejson.tiles) ? tilejson.tiles[0] : undefined;
  if (typeof tile !== "string" || !["{z}", "{x}", "{y}"].every((tag) => tile.includes(tag))) {
    throw new Error("Terrain TileJSON has no z/x/y tile template");
  }
  return tile;
}

/** Register a lazy, worker-backed contour protocol only when online Terrain is selected. */
export function generatedContourUrl(
  demTileUrl: string,
  encoding: "mapbox" | "terrarium",
): Promise<string> {
  const key = `${encoding}:${demTileUrl}`;
  const existing = contourSources.get(key);
  if (existing) return existing;

  const pending = Promise.all([import("maplibre-contour"), loadMapLibreRuntime()]).then(
    ([{ default: contour }, maplibre]) => {
      const source = new contour.DemSource({
        url: demTileUrl,
        encoding,
        // The worldwide Mapterhorn coverage is complete at z12; higher-zoom
        // DEM tiles are regional. MapLibre overzooms the generated vectors.
        maxzoom: 12,
        worker: true,
      });
      source.setupMaplibre(maplibre);
      return source.contourProtocolUrl({
        thresholds: { 9: [100, 500], 12: [20, 100], 14: [10, 50], 15: [10, 50] },
        overzoom: 1,
        contourLayer: "contours",
        elevationKey: "ele",
        levelKey: "level",
      });
    },
  );
  contourSources.set(key, pending);
  void pending.catch(() => contourSources.delete(key));
  return pending;
}
