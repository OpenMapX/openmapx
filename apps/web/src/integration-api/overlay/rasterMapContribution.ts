import type { Map as MapLibreMap } from "maplibre-gl";
import { isAttributionLayerVisible } from "./renderedFeatureVisibility";

const diagnosed = new WeakSet<MapLibreMap>();

function hasEvaluatedPaint(value: unknown): value is { get(property: "raster-opacity"): unknown } {
  return !!value && typeof value === "object" && "get" in value && typeof value.get === "function";
}

/**
 * Host-only MapLibre 6.13 bridge to the same retained coordinates/texture used
 * by drawRaster. Source settled/success-event history cannot distinguish
 * offscreen cache entries or eviction, nor failed initial acquisitions.
 * Keep this engine coupling here: no private underscore fields or style casts.
 */
export function rasterMapContributes(map: MapLibreMap, layerId: string, sourceId: string): boolean {
  if (!isAttributionLayerVisible(map, layerId)) return false;
  const layer = map.getLayer(layerId);
  if (layer?.type !== "raster" || layer.source !== sourceId) return false;
  const paint = map.style?.getLayer(layerId)?.paint;
  const manager = map.style?.tileManagers?.[sourceId];
  if (
    !hasEvaluatedPaint(paint) ||
    !manager ||
    typeof manager.getVisibleCoordinates !== "function" ||
    typeof manager.getTile !== "function"
  ) {
    if (!diagnosed.has(map)) {
      diagnosed.add(map);
      console.warn(
        "[map-attribution] Raster contribution tracking unavailable: expected the MapLibre 6.13 retained-tile adapter.",
      );
    }
    return false;
  }
  const opacity = paint.get("raster-opacity");
  if (typeof opacity !== "number" || opacity <= 0) return false;
  for (const coordinate of manager.getVisibleCoordinates()) {
    const tile = manager.getTile(coordinate);
    if (!tile?.hasData() || !tile.texture) continue;
    if (tile.fadeOpacity > 0) return true;
    // drawRaster can still sample the parent's texture when an incoming child
    // starts at zero opacity. That parent may be retained outside the live list.
    const parent = tile.fadingParentID && manager.getLoadedTile(tile.fadingParentID);
    if (parent?.hasData() && parent.texture) return true;
  }
  return false;
}
