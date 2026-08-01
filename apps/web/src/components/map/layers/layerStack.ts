"use client";

import type maplibregl from "maplibre-gl";

/**
 * The canonical bottom-to-top order of every map layer this app draws. A layer
 * declares the slot it belongs to instead of racing other create-effects with
 * `moveLayer`, which is what previously made the route sit above incidents in
 * one context and below them in another.
 *
 * `basemap-symbols` is a virtual slot: it stands for the base style's first
 * symbol layer (labels, shields). Slots below it are inserted before that layer,
 * slots above it end up on top of the base style's labels.
 */
export const MAP_LAYER_SLOTS = [
  "base-raster",
  // Its own rung under every vector overlay: a raster overlay that merely sits
  // "below the labels" repaints over the data overlays it shares that band with.
  "raster-overlays",
  "area-overlays",
  "overlay-lines",
  "traffic-flow",
  "route-alt",
  "route-active",
  "route-congestion",
  "conditions-lines",
  "overlay-points",
  "overlay-markers",
  "basemap-symbols",
  "route-markers",
  "nav-top",
] as const;

export type MapLayerSlot = (typeof MAP_LAYER_SLOTS)[number];

export interface LayerRegistration {
  id: string;
  slot: MapLayerSlot;
  /** Position within the slot; lower renders below. */
  order: number;
}

/** The subset of a style layer the ordering logic reads. */
export interface StackLayer {
  id: string;
  type: string;
}

/** The subset of the MapLibre map the ordering logic drives. */
export interface StackMap {
  getStyle(): { layers?: StackLayer[] } | undefined;
  getLayer(id: string): unknown;
  moveLayer(id: string, beforeId?: string): unknown;
}

const SYMBOL_SLOT_INDEX = MAP_LAYER_SLOTS.indexOf("basemap-symbols");

const registry = new Map<string, LayerRegistration>();

export function registerLayerSlot(layerId: string, slot: MapLayerSlot, order = 0): void {
  registry.set(layerId, { id: layerId, slot, order });
}

export function unregisterLayerSlot(layerId: string): void {
  registry.delete(layerId);
}

export function layerRegistrations(): LayerRegistration[] {
  return [...registry.values()];
}

function rankOf(slot: MapLayerSlot, order: number): number {
  return MAP_LAYER_SLOTS.indexOf(slot) * 1000 + order;
}

/**
 * The base style's own first symbol layer (labels, shields) — the anchor
 * everything below `basemap-symbols` inserts before. Registered layers are
 * excluded from the search: several overlay-markers layers are themselves
 * `type: "symbol"` (e.g. POI labels), and once one lands earlier in the style
 * than the true base layer, treating it as the anchor would fold the stack
 * back on itself instead of resolving to the real boundary.
 *
 * Returns `undefined` when every `type: "symbol"` layer in the style is
 * itself registered — a transient state mid-load, or a base style that ships
 * no label layer at all. Callers then treat "top of stack" as the anchor, so
 * a below-labels layer briefly lands above everything until the next
 * `styledata`/`idle` pass re-runs `anchorMapLayers` and repairs it. Don't read
 * the very first `resolveBeforeId` call in a create-effect as authoritative.
 */
function firstSymbolLayerId(
  styleLayers: readonly StackLayer[],
  registrations: readonly LayerRegistration[],
): string | undefined {
  const registeredIds = new Set(registrations.map((r) => r.id));
  return styleLayers.find((layer) => layer.type === "symbol" && !registeredIds.has(layer.id))?.id;
}

/**
 * The id the given slot's layer must be inserted before, so that it lands in
 * canonical order: the first registered layer ranked strictly above it, or the
 * base style's first symbol layer when nothing registered sits above and the
 * slot belongs under the labels. `undefined` means "top of the stack".
 */
export function resolveBeforeId(
  styleLayers: readonly StackLayer[],
  registrations: readonly LayerRegistration[],
  slot: MapLayerSlot,
  order = 0,
): string | undefined {
  const rank = rankOf(slot, order);
  const byId = new Map(registrations.map((r) => [r.id, r]));
  for (const layer of styleLayers) {
    const registration = byId.get(layer.id);
    if (registration && rankOf(registration.slot, registration.order) > rank) return layer.id;
  }
  return MAP_LAYER_SLOTS.indexOf(slot) < SYMBOL_SLOT_INDEX
    ? firstSymbolLayerId(styleLayers, registrations)
    : undefined;
}

/**
 * The `moveLayer` calls that put every registered layer back into canonical
 * order, or `[]` when the stack is already correct. Moves are emitted top-rank
 * first, each anchored before the previously placed layer, so applying them in
 * order produces the canonical stack in a single pass.
 */
export function planAnchorMoves(
  styleLayers: readonly StackLayer[],
  registrations: readonly LayerRegistration[],
): Array<{ id: string; beforeId: string | undefined }> {
  const present = registrations
    .filter((r) => styleLayers.some((layer) => layer.id === r.id))
    .sort((a, b) => rankOf(a.slot, a.order) - rankOf(b.slot, b.order));
  if (present.length === 0) return [];

  const symbolId = firstSymbolLayerId(styleLayers, registrations);
  const indexOf = (id: string) => styleLayers.findIndex((layer) => layer.id === id);
  const symbolIndex = symbolId === undefined ? Number.POSITIVE_INFINITY : indexOf(symbolId);

  const ordered = present.every((r, i) => i === 0 || indexOf(present[i - 1].id) < indexOf(r.id));
  const straddled = present.every((r) => {
    const belowLabels = MAP_LAYER_SLOTS.indexOf(r.slot) < SYMBOL_SLOT_INDEX;
    return belowLabels ? indexOf(r.id) < symbolIndex : indexOf(r.id) > symbolIndex;
  });
  if (ordered && straddled) return [];

  const moves: Array<{ id: string; beforeId: string | undefined }> = [];
  let beforeId: string | undefined;
  for (let i = present.length - 1; i >= 0; i--) {
    const registration = present[i];
    const belowLabels = MAP_LAYER_SLOTS.indexOf(registration.slot) < SYMBOL_SLOT_INDEX;
    moves.push({ id: registration.id, beforeId: beforeId ?? (belowLabels ? symbolId : undefined) });
    beforeId = registration.id;
  }
  return moves;
}

/** Add a layer already anchored in its slot, so it never flashes at the wrong depth. */
export function addLayerInSlot(
  map: maplibregl.Map,
  spec: maplibregl.AddLayerObject,
  slot: MapLayerSlot,
  order = 0,
): void {
  const styleLayers = (map.getStyle()?.layers ?? []) as StackLayer[];
  registerLayerSlot(spec.id, slot, order);
  map.addLayer(spec, resolveBeforeId(styleLayers, layerRegistrations(), slot, order));
}

/** Re-assert the whole canonical order. Idempotent and cheap when nothing moved. */
export function anchorMapLayers(map: StackMap): void {
  const styleLayers = map.getStyle()?.layers ?? [];
  if (styleLayers.length === 0) return;
  for (const move of planAnchorMoves(styleLayers, layerRegistrations())) {
    if (map.getLayer(move.id)) map.moveLayer(move.id, move.beforeId);
  }
}
