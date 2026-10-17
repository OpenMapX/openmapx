"use client";

import type * as maplibregl from "maplibre-gl";
import { addLayerInSlot, layerRank, type MapLayerSlot, unregisterLayerSlot } from "./layerStack";

/**
 * The empty GeoJSON payload, with one identity. A group compares source data by
 * reference, so a descriptor rebuilt with this constant never resets data that
 * a GeoJSON data bridge has since published into the source. Never mutate it.
 */
export const EMPTY_FEATURE_COLLECTION: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

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
 * applied synchronously; the loader is invoked once per style while the image
 * is absent.
 */
export interface MapLayerGroup {
  sources: Record<string, maplibregl.SourceSpecification>;
  layers: SlottedLayer[];
  images?: Record<string, (map: maplibregl.Map) => void>;
}

/**
 * A layer as last applied, split into what MapLibre can update on a live layer
 * and what it cannot. Each part is serialised so an unchanged pass compares
 * strings rather than walking expressions.
 */
export interface AppliedLayer {
  /** Type, source, slot, order and the rest — a change here means re-add. */
  structure: string;
  paint: string;
  layout: string;
  filter: string;
  zoom: string;
  spec: LayerProperties;
}

type LayerProperties = maplibregl.AddLayerObject & {
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
  filter?: maplibregl.FilterSpecification;
  minzoom?: number;
  maxzoom?: number;
};

/** What was last put on the map, so the next pass can tell what changed. */
export interface AppliedGroup {
  /** Source spec minus `data`, serialised — a change here means recreate. */
  sourceShape: Map<string, string>;
  /** Last applied `data`, by reference — a change here means `setData`. */
  sourceData: Map<string, unknown>;
  layerSpecs: Map<string, AppliedLayer>;
  /** Images whose loader already ran against this style, loaded or still loading. */
  requestedImages: Set<string>;
  sourceIds: string[];
  layerIds: string[];
}

export function emptyApplied(): AppliedGroup {
  return {
    sourceShape: new Map(),
    sourceData: new Map(),
    layerSpecs: new Map(),
    requestedImages: new Set(),
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

function appliedLayer(layer: SlottedLayer): AppliedLayer {
  const { slot, order, ...spec } = layer as SlottedLayer & LayerProperties;
  const { paint, layout, filter, minzoom, maxzoom, ...rest } = spec;
  return {
    structure: JSON.stringify({ rest, slot, order: order ?? 0 }),
    paint: JSON.stringify(paint ?? {}),
    layout: JSON.stringify(layout ?? {}),
    filter: JSON.stringify(filter ?? null),
    zoom: JSON.stringify([minzoom, maxzoom]),
    spec,
  };
}

/** The property names and values come from a layer spec MapLibre accepted. */
type PropertySetter = (layerId: string, name: string, value: unknown) => unknown;

function updateProperties(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
  set: (name: string, value: unknown) => void,
): void {
  for (const name of new Set([...Object.keys(previous ?? {}), ...Object.keys(next ?? {})])) {
    const value = next?.[name];
    // An omitted property is set to `undefined`, which restores its default.
    if (JSON.stringify(previous?.[name]) !== JSON.stringify(value)) set(name, value);
  }
}

/**
 * Bring a live layer's paint, layout, filter and zoom range in line with
 * `next`. Returns false when the layer has to be re-added instead: its
 * structure changed, or nothing records what it was created from.
 *
 * Re-adding drops the layer's rendered tiles until the worker rebuilds them,
 * so a recolour or a filter toggle would blink; updating in place does not.
 */
function updateLayer(
  map: maplibregl.Map,
  previous: AppliedLayer | undefined,
  next: AppliedLayer,
): boolean {
  if (!previous || previous.structure !== next.structure) return false;
  const id = next.spec.id;
  if (previous.paint !== next.paint) {
    const setPaint = map.setPaintProperty.bind(map) as PropertySetter;
    updateProperties(previous.spec.paint, next.spec.paint, (name, value) =>
      setPaint(id, name, value),
    );
  }
  if (previous.layout !== next.layout) {
    const setLayout = map.setLayoutProperty.bind(map) as PropertySetter;
    updateProperties(previous.spec.layout, next.spec.layout, (name, value) =>
      setLayout(id, name, value),
    );
  }
  if (previous.filter !== next.filter) map.setFilter(id, next.spec.filter ?? null);
  if (previous.zoom !== next.zoom) {
    map.setLayerZoomRange(id, next.spec.minzoom ?? 0, next.spec.maxzoom ?? 24);
  }
  return true;
}

/**
 * Bring the map in line with `desired`, given what was last applied. Safe to call
 * on every render: unchanged sources and layers are left alone, so the cost of a
 * no-op pass is a handful of map lookups and reference comparisons.
 *
 * Pass `emptyApplied()` after a style change — everything really is gone, so the
 * whole group is recreated in one pass. Pass `null` as `desired` to tear down.
 *
 * A layer whose paint, layout, filter or zoom range changed is updated in
 * place; any other change to its spec, slot or order removes and re-adds it.
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

  const next = emptyApplied();

  // A loader is asynchronous: until its image arrives, `hasImage` stays false
  // and every render would start another load. Run each once per style.
  for (const [id, load] of Object.entries(desired.images ?? {})) {
    if (!map.hasImage(id) && !applied.requestedImages.has(id)) load(map);
    next.requestedImages.add(id);
  }

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
        void (source as maplibregl.GeoJSONSource).setData(
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
    const state = appliedLayer(layer);
    if (map.getLayer(layer.id) && !updateLayer(map, applied.layerSpecs.get(layer.id), state)) {
      removeLayer(map, layer.id);
    }
    if (!map.getLayer(layer.id)) {
      addLayerInSlot(map, spec, slot, order);
    }
    next.layerSpecs.set(layer.id, state);
    next.layerIds.push(layer.id);
  }

  return next;
}
