import type { Attribution } from "@openmapx/mobility-core/attribution";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import type {
  Map as MapLibreMap,
  RasterDEMSourceSpecification,
  RasterSourceSpecification,
  RasterTileSource,
} from "maplibre-gl";

import type { RasterPayloadOpacity } from "./rasterPayloadOpacity";
import { beginRasterResponseAcquisition } from "./rasterResponseProtocol";

import { isAttributionLayerVisible } from "./renderedFeatureVisibility";

type RasterTile = Parameters<RasterTileSource["loadTile"]>[0];
interface TileReceipt {
  pending: Attribution[];
  opacity?: RasterPayloadOpacity;
  texture?: object;
  dem?: object;
  contributors?: Attribution[];
}
interface SourceReceipts {
  current: Attribution[];
  tiles: WeakMap<object, TileReceipt>;
  instrumented: boolean;
}
const sourceReceipts = new WeakMap<object, SourceReceipts>();

type SourceMap = Pick<MapLibreMap, "getSource" | "addSource">;

function receiptState(
  map: Pick<MapLibreMap, "getSource">,
  sourceId: string,
  contributors: readonly Attribution[],
) {
  const source = map.getSource(sourceId);
  if (!source) return undefined;
  let state = sourceReceipts.get(source);
  if (!state) {
    state = {
      current: snapshotContributors(contributors),
      tiles: new WeakMap(),
      instrumented: false,
    };
    sourceReceipts.set(source, state);
  }
  return state;
}

/**
 * Required acquisition seam for host raster overlays. Install before adding a
 * layer: MapLibre's public loadTile method includes initial loads AND silent
 * expiry/reloads, unlike sourcedataloading. Each successful invocation owns a
 * tile/content generation even when the GPU reuses a texture object.
 * Source IDs may be reused; source-object and tile-object WeakMaps bound lifetime.
 */
export function addAttributedRasterSource(
  map: SourceMap,
  sourceId: string,
  specification: RasterSourceSpecification | RasterDEMSourceSpecification,
  contributors: readonly Attribution[],
  receiptMode: "uniform" | "response" = "uniform",
): void {
  map.addSource(sourceId, specification);
  const source = map.getSource<RasterTileSource>(sourceId);
  const state = receiptState(map, sourceId, contributors);
  if (!source || !state || typeof source.loadTile !== "function") return;
  state.instrumented = true;
  const loadTile = source.loadTile;
  source.loadTile = function (tile) {
    const response =
      this.type === "raster" || receiptMode === "response"
        ? beginRasterResponseAcquisition(this)
        : undefined;
    const uniform = snapshotContributors(state.current);
    const captured = () =>
      receiptMode === "response" ? (response?.contributors() ?? []) : uniform;
    retainTile(state, tile);
    let assignedTexture = false;
    let assignedDem = false;
    // MapLibre 6.16 writes texture (including pooled/reused objects), uploads
    // content, then writes state="loaded" synchronously in this invocation.
    // Observe that exact public commit, not Promise completion or newest start:
    // concurrent older requests can overwrite newer content. Forward all reads
    // and writes to the original tile, preserving engine request/abort behavior.
    const acquisitionTile = new Proxy(tile, {
      set(target, property, value) {
        const written = Reflect.set(target, property, value, target);
        if (!written) return false;
        if (property === "texture") assignedTexture = true;
        if (property === "dem") assignedDem = true;
        if (property === "state" && value === "loaded" && assignedTexture && target.texture) {
          state.tiles.set(tile, {
            pending: captured(),
            texture: target.texture,
            opacity: response?.opacity() ?? "unknown",
            contributors: captured(),
          });
        }
        // RasterDEMTileSource commits worker-decoded DEM before state=loaded.
        // Empty 204s and failed/aborted reloads do not replace that content.
        if (property === "state" && value === "loaded" && assignedDem && target.dem) {
          state.tiles.set(tile, { pending: captured(), dem: target.dem, contributors: captured() });
        }
        return true;
      },
    });
    return loadTile
      .call(response?.source ?? this, acquisitionTile)
      .finally(() => response?.dispose());
  };
}

function retainTile(state: SourceReceipts, tile: RasterTile): TileReceipt {
  let receipt = state.tiles.get(tile);
  if (!receipt) {
    receipt = { pending: snapshotContributors(state.current) };
    state.tiles.set(tile, receipt);
  }
  // Compatibility for already mounted host sources: observe pending objects
  // before metadata updates. Instrumented sources commit at acquisition success.
  if (!state.instrumented && tile.hasData() && tile.texture && receipt.texture !== tile.texture) {
    receipt.texture = tile.texture;
    receipt.contributors = snapshotContributors(receipt.pending);
  }
  return receipt;
}

/** Update only future acquisitions; capture existing pending/retained objects first. */
export function updateRasterAcquisitionContributors(
  map: Pick<MapLibreMap, "getSource"> & Partial<Pick<MapLibreMap, "style">>,
  sourceId: string,
  contributors: readonly Attribution[],
): void {
  const state = receiptState(map, sourceId, contributors);
  if (!state) return;
  const manager = map.style?.tileManagers?.[sourceId];
  if (
    manager &&
    typeof manager.getVisibleCoordinates === "function" &&
    typeof manager.getTile === "function"
  ) {
    for (const coordinate of manager.getVisibleCoordinates()) {
      const tile = manager.getTile(coordinate);
      if (!tile) continue;
      retainTile(state, tile);
      const parent = tile.fadingParentID && manager.getLoadedTile?.(tile.fadingParentID);
      if (parent) retainTile(state, parent);
    }
  }
  state.current = snapshotContributors(contributors);
}

const diagnosed = new WeakSet<MapLibreMap>();

function hasEvaluatedPaint(
  value: unknown,
): value is { get(property: "raster-opacity" | "raster-fade-duration"): unknown } {
  return !!value && typeof value === "object" && "get" in value && typeof value.get === "function";
}

/**
 * Host-only MapLibre 6.16 bridge to the same retained coordinates/texture used
 * by drawRaster. Source settled/success-event history cannot distinguish
 * offscreen cache entries or eviction, nor failed initial acquisitions.
 * Keep this engine coupling here: no private underscore fields or style casts.
 */
export function rasterMapContributors(
  map: MapLibreMap,
  layerId: string,
  sourceId: string,
): Attribution[] {
  if (!isAttributionLayerVisible(map, layerId)) return [];
  const layer = map.getLayer(layerId);
  if (layer?.type !== "raster" || layer.source !== sourceId) return [];
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
        "[map-attribution] Raster contribution tracking unavailable: expected the MapLibre 6.16 retained-tile adapter.",
      );
    }
    return [];
  }
  const opacity = paint.get("raster-opacity");
  if (typeof opacity !== "number" || opacity <= 0) return [];
  const state = receiptState(map, sourceId, []);
  if (!state) return [];
  const receipts: Attribution[][] = [];
  const noFade = paint.get("raster-fade-duration") === 0 || !!map.terrain;
  for (const coordinate of manager.getVisibleCoordinates()) {
    const tile = manager.getTile(coordinate);
    if (!tile) continue;
    const receipt = retainTile(state, tile);
    if (!tile.hasData() || !tile.texture) continue;
    if (
      (noFade || tile.fadeOpacity > 0) &&
      receipt.texture === tile.texture &&
      receipt.opacity !== "transparent"
    )
      receipts.push(receipt.contributors ?? []);
    // drawRaster samples both textures during a fade, including the retained
    // parent when the incoming child starts at zero opacity.
    const parent =
      !noFade && tile.fadingParentID ? manager.getLoadedTile?.(tile.fadingParentID) : undefined;
    if (tile.fadeOpacity < 1 && parent?.hasData() && parent.texture) {
      const parentReceipt = retainTile(state, parent);
      if (parentReceipt.texture === parent.texture && parentReceipt.opacity !== "transparent")
        receipts.push(parentReceipt.contributors ?? []);
    }
  }
  return snapshotContributors(...receipts);
}

/** Host-only DEM receipt for the exact successfully committed decoded content. */
export function retainedDemContributors(
  map: MapLibreMap,
  sourceId: string,
  tile: RasterTile,
): Attribution[] {
  const source = map.getSource(sourceId);
  const receipt = source && sourceReceipts.get(source)?.tiles.get(tile);
  return tile.dem && receipt?.dem === tile.dem
    ? snapshotContributors(receipt.contributors ?? [])
    : [];
}
