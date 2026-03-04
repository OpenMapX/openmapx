"use client";

import type maplibregl from "maplibre-gl";

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
