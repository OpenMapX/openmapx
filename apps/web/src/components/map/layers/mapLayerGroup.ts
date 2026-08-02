"use client";

import type maplibregl from "maplibre-gl";
import { addLayerInSlot, layerRank, type MapLayerSlot, unregisterLayerSlot } from "./layerStack";

/** A layer spec plus the slot that decides its depth. */
export type SlottedLayer = maplibregl.AddLayerObject & {
  slot: MapLayerSlot;
  order?: number;
};

/**
 * Everything one component draws, as data rather than as a sequence of calls.
 *
 * A GeoJSON source carries its `data`, which is the whole point: `setStyle`
 * destroys every source the app added, and a source recreated empty renders
 * nothing with no error, no warning and no failing test. Because the data is part
 * of the thing being created, that state cannot occur — the rebuild puts back
 * whatever was last published.
 *
 * `images` is the one imperative escape hatch. Registering an image is
 * asynchronous (an `Image.onload` round-trip), so it cannot be expressed as data
 * applied synchronously; the loader is invoked only when the image is absent.
 */
export interface MapLayerGroup {
  sources: Record<string, maplibregl.SourceSpecification>;
  layers: SlottedLayer[];
  images?: Record<string, (map: maplibregl.Map) => void>;
}

/** What was last put on the map, so the next pass can tell what changed. */
export interface AppliedGroup {
  /** Source spec minus `data`, serialised — a change here means recreate. */
  sourceShape: Map<string, string>;
  /** Last applied `data`, by reference — a change here means `setData`. */
  sourceData: Map<string, unknown>;
  layerSpecs: Map<string, string>;
  sourceIds: string[];
  layerIds: string[];
}

export function emptyApplied(): AppliedGroup {
  return {
    sourceShape: new Map(),
    sourceData: new Map(),
    layerSpecs: new Map(),
    sourceIds: [],
    layerIds: [],
  };
}

function splitLayer(layer: SlottedLayer) {
  const { slot, order, ...spec } = layer;
  return { spec: spec as maplibregl.AddLayerObject, slot, order: order ?? 0 };
}

function shapeOf(spec: maplibregl.SourceSpecification): string {
  return JSON.stringify({ ...(spec as Record<string, unknown>), data: undefined });
}

function removeLayer(map: maplibregl.Map, id: string): void {
  if (map.getLayer(id)) map.removeLayer(id);
  unregisterLayerSlot(id);
}

/**
 * Bring the map in line with `desired`, given what was last applied. Safe to call
 * on every render: unchanged sources and layers are left alone, so the cost of a
 * no-op pass is a handful of map lookups and reference comparisons.
 *
 * Pass `emptyApplied()` after a style change — everything really is gone, so the
 * whole group is recreated in one pass. Pass `null` as `desired` to tear down.
 *
 * A layer whose spec changed is removed and re-added rather than having its paint
 * and layout diffed property by property. Diffing is a fresh way to get things
 * silently wrong, which is the failure mode this module exists to remove.
 */
export function applyGroup(
  map: maplibregl.Map,
  desired: MapLayerGroup | null,
  applied: AppliedGroup,
): AppliedGroup {
  const wantedSources = desired?.sources ?? {};
  const wantedLayers = desired?.layers ?? [];
  const wantedLayerIds = new Set(wantedLayers.map((layer) => layer.id));
  const wantedSourceIds = new Set(Object.keys(wantedSources));

  // Layers first: a source cannot be removed while a layer still reads from it.
  for (const id of applied.layerIds) {
    if (!wantedLayerIds.has(id)) removeLayer(map, id);
  }
  for (const id of applied.sourceIds) {
    if (!wantedSourceIds.has(id) && map.getSource(id)) map.removeSource(id);
  }

  if (!desired) return emptyApplied();

  for (const [id, load] of Object.entries(desired.images ?? {})) {
    if (!map.hasImage(id)) load(map);
  }

  const next = emptyApplied();

  for (const [id, spec] of Object.entries(wantedSources)) {
    const shape = shapeOf(spec);
    const data = (spec as { data?: unknown }).data;
    const existing = map.getSource(id);

    if (existing && shape !== applied.sourceShape.get(id)) {
      // The source itself changed (new tile URLs, a different type). Its layers
      // are re-added below, once the replacement exists.
      for (const layer of wantedLayers) removeLayer(map, layer.id);
      map.removeSource(id);
    }

    if (!map.getSource(id)) {
      map.addSource(id, spec);
    } else if (data !== undefined && data !== applied.sourceData.get(id)) {
      const source = map.getSource(id);
      if (source?.type === "geojson") {
        (source as maplibregl.GeoJSONSource).setData(
          data as Parameters<maplibregl.GeoJSONSource["setData"]>[0],
        );
      }
    }

    next.sourceShape.set(id, shape);
    next.sourceData.set(id, data);
    next.sourceIds.push(id);
  }

  const ordered = [...wantedLayers].sort(
    (a, b) => layerRank(a.slot, a.order ?? 0) - layerRank(b.slot, b.order ?? 0),
  );

  for (const layer of ordered) {
    const { spec, slot, order } = splitLayer(layer);
    const key = JSON.stringify({ spec, slot, order });
    if (map.getLayer(layer.id) && key !== applied.layerSpecs.get(layer.id)) {
      removeLayer(map, layer.id);
    }
    if (!map.getLayer(layer.id)) {
      addLayerInSlot(map, spec, slot, order);
    }
    next.layerSpecs.set(layer.id, key);
    next.layerIds.push(layer.id);
  }

  return next;
}
