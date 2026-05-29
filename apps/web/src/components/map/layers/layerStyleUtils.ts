"use client";

import type maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";

/**
 * Guarded teardown of one or more layers followed by their source. Layers are
 * removed in the order given (callers must pass top-most/dependent layers
 * first), then the source. Wrapped in a try/catch that swallows errors because
 * the style may already have been torn down (e.g. during a style change), which
 * makes `getLayer`/`getSource` lie about presence.
 */
export function removeLayerAndSource(
  map: maplibregl.Map,
  layerIds: string | string[],
  sourceId: string,
): void {
  const ids = typeof layerIds === "string" ? [layerIds] : layerIds;
  try {
    for (const id of ids) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  } catch {
    // Source/layer may already be torn down during a style change
  }
}

/**
 * Upsert a GeoJSON source: if it already exists, call `setData`; otherwise
 * `addSource` with `{ type: "geojson", data }`. Returns the resolved
 * `GeoJSONSource`. Does NOT add any layers — callers keep their own
 * `addLayer` calls (some gate them on the source not having existed).
 */
export function upsertGeoJsonSource(
  map: maplibregl.Map,
  sourceId: string,
  data: Parameters<GeoJSONSource["setData"]>[0],
): GeoJSONSource {
  const existing = map.getSource(sourceId) as GeoJSONSource | undefined;
  if (existing) {
    existing.setData(data);
    return existing;
  }
  map.addSource(sourceId, { type: "geojson", data });
  return map.getSource(sourceId) as GeoJSONSource;
}

export interface VectorLineReference {
  source: string;
  sourceLayer: string;
}

export function getFirstSymbolLayerId(map: maplibregl.Map): string | undefined {
  const layers = map.getStyle().layers;
  return layers?.find((layer) => layer.type === "symbol")?.id;
}

export function findVectorLineReference(
  map: maplibregl.Map,
  sourceHints: readonly RegExp[],
): VectorLineReference | null {
  const layers = map.getStyle().layers;
  if (!layers) return null;

  for (const layer of layers) {
    if (layer.type !== "line") continue;
    if (!("source" in layer) || !("source-layer" in layer)) continue;

    const source = layer.source;
    const sourceLayer = layer["source-layer"];
    if (typeof source !== "string" || typeof sourceLayer !== "string") continue;

    const matches = sourceHints.some((hint) => hint.test(layer.id) || hint.test(sourceLayer));
    if (!matches) continue;

    return { source, sourceLayer };
  }

  return null;
}

export function setLayerVisibility(map: maplibregl.Map, layerId: string, visible: boolean): void {
  if (!map.getLayer(layerId)) return;
  map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
}

export function moveLayerBeforeFirstSymbol(map: maplibregl.Map, layerId: string): void {
  if (!map.getLayer(layerId)) return;
  const beforeLayerId = getFirstSymbolLayerId(map);
  if (beforeLayerId) {
    map.moveLayer(layerId, beforeLayerId);
    return;
  }
  map.moveLayer(layerId);
}
