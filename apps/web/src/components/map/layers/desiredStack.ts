"use client";

import type maplibregl from "maplibre-gl";

interface DesiredEntry {
  sourceIds: string[];
  layerIds: string[];
}

/**
 * What every mounted layer group intends to have on the map right now.
 *
 * The point is to make one failure mode detectable: a layer that should be
 * drawing and is not renders exactly like a layer with nothing to draw — no
 * error, no warning. Comparing intent against the map tells the two apart.
 */
const desired = new Map<string, DesiredEntry>();

export function recordDesired(key: string, entry: DesiredEntry): void {
  desired.set(key, entry);
}

export function clearDesired(key: string): void {
  desired.delete(key);
}

export function findMissingLayers(
  map: Pick<maplibregl.Map, "getLayer" | "getSource">,
): Array<{ key: string; missing: string[] }> {
  const results: Array<{ key: string; missing: string[] }> = [];
  for (const [key, entry] of desired) {
    const missing = [
      ...entry.sourceIds.filter((id) => !map.getSource(id)).map((id) => `source:${id}`),
      ...entry.layerIds.filter((id) => !map.getLayer(id)).map((id) => `layer:${id}`),
    ];
    if (missing.length > 0) results.push({ key, missing });
  }
  return results;
}
