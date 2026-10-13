import type { Attribution } from "@openmapx/mobility-core/attribution";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import type { Map as MapLibreMap, RasterDEMTileSource } from "maplibre-gl";
import { retainedDemContributors } from "./rasterMapContribution";
import { isAttributionLayerVisible } from "./renderedFeatureVisibility";

function hasEvaluatedPaint(value: unknown): value is { get(property: string): unknown } {
  return !!value && typeof value === "object" && "get" in value && typeof value.get === "function";
}

function hasColorAlpha(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if ("a" in value && typeof value.a === "number") return value.a > 0;
  return "values" in value && Array.isArray(value.values) && value.values.some(hasColorAlpha);
}

type Dem = NonNullable<Parameters<RasterDEMTileSource["loadTile"]>[0]["dem"]>;
const colorAlpha = new WeakMap<Dem, WeakMap<object, boolean>>();

function hasElevationEvaluator(value: unknown): value is {
  evaluate(globals: { elevation: number }): unknown;
} {
  return (
    !!value &&
    typeof value === "object" &&
    "evaluate" in value &&
    typeof value.evaluate === "function"
  );
}

/** Use the engine's prepared native ramp, never a second raw-style evaluator. */
function hasColorReliefAlpha(dem: Dem, expression: unknown): boolean {
  if (!hasElevationEvaluator(expression)) return false;
  let byExpression = colorAlpha.get(dem);
  const cached = byExpression?.get(expression);
  if (cached !== undefined) return cached;
  // DEM min/max come from its actual interior samples. Most opaque ramps
  // certify immediately; transparent selective ranges scan only once per
  // immutable DEM/ramp generation, not on every scheduler refresh.
  let positive = [dem.min, dem.max].some(
    (elevation) =>
      typeof elevation === "number" && hasColorAlpha(expression.evaluate({ elevation })),
  );
  if (!positive && typeof dem.get === "function") {
    for (let y = 0; y < dem.dim && !positive; y++) {
      for (let x = 0; x < dem.dim && !positive; x++)
        positive = hasColorAlpha(expression.evaluate({ elevation: dem.get(x, y) }));
    }
  }
  if (!byExpression) {
    byExpression = new WeakMap();
    colorAlpha.set(dem, byExpression);
  }
  byExpression.set(expression, positive);
  return positive;
}

/**
 * Host-only MapLibre 6.13 adapter. Hillshade samples a prepared FBO; color
 * relief samples a prepared DEM texture; terrain samples source DEMs covering
 * its current renderable mesh, including loaded parents in the out-of-view cache.
 * Source maxzoom is an acquisition limit, not a layer disappearance rule.
 * Kept separate from queryable geometry and used by the same shared scheduler.
 */
export function demMapContributors(
  map: MapLibreMap,
  descriptors: readonly { layerId: string; sourceId: string }[],
  terrainSourceId?: string,
): Attribution[] {
  const groups: Attribution[][] = [];
  for (const { layerId, sourceId } of descriptors) {
    if (!isAttributionLayerVisible(map, layerId)) continue;
    const layer = map.getLayer(layerId);
    if (!layer || layer.source !== sourceId) continue;
    const evaluated = map.style?.getLayer(layerId);
    const manager = map.style?.tileManagers?.[sourceId];
    if (
      !evaluated ||
      !hasEvaluatedPaint(evaluated.paint) ||
      !manager ||
      typeof manager.getVisibleCoordinates !== "function" ||
      typeof manager.getTile !== "function"
    )
      continue;
    const paint = evaluated.paint;
    let positive = false;
    if (evaluated.type === "hillshade") {
      const exaggeration = paint.get("hillshade-exaggeration");
      positive =
        typeof exaggeration === "number" &&
        exaggeration > 0 &&
        ["hillshade-shadow-color", "hillshade-highlight-color", "hillshade-accent-color"].some(
          (property) => hasColorAlpha(paint.get(property)),
        );
    } else if (evaluated.type === "color-relief") {
      const opacity = paint.get("color-relief-opacity");
      positive = typeof opacity === "number" && opacity > 0;
    }
    if (!positive) continue;
    for (const coordinate of manager.getVisibleCoordinates()) {
      const tile = manager.getTile(coordinate);
      if (!tile?.dem?.data) continue;
      if (evaluated.type === "hillshade" && (!tile.fbo || tile.needsHillshadePrepare)) continue;
      if (
        evaluated.type === "color-relief" &&
        (!tile.demTexture ||
          tile.needsColorReliefPrepare ||
          !("colorRampExpression" in evaluated) ||
          !hasColorReliefAlpha(tile.dem, evaluated.colorRampExpression))
      )
        continue;
      groups.push(retainedDemContributors(map, sourceId, tile));
    }
  }
  const terrain = map.terrain;
  if (
    terrainSourceId &&
    map.getTerrain()?.source === terrainSourceId &&
    terrain?.exaggeration > 0 &&
    typeof terrain.tileManager?.getRenderableTiles === "function" &&
    typeof terrain.tileManager?.getSourceTile === "function" &&
    terrain.tileManager.getSource() === map.getSource(terrainSourceId)
  ) {
    for (const mesh of terrain.tileManager.getRenderableTiles()) {
      const tile = mesh && terrain.tileManager.getSourceTile(mesh.tileID, true);
      if (tile?.dem?.data && tile.demTexture && !tile.needsTerrainPrepare)
        groups.push(retainedDemContributors(map, terrainSourceId, tile));
    }
  }
  return snapshotContributors(...groups);
}
