"use client";

import type * as maplibregl from "maplibre-gl";

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
  // Above the points, not below them with the other area fills: a heatmap
  // renders the same features its circle layer does, and those circles sit
  // exactly on the heat maxima. Underneath, an opaque marker covers the hot
  // core and leaves only the cool outer halo showing — the density peak, which
  // is the whole point of a heatmap, becomes the one part you cannot see.
  "overlay-heat",
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

/** Sort key for a slot+order pair; lower renders below. */
export function layerRank(slot: MapLayerSlot, order = 0): number {
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
 * canonical order: whichever comes first in style order — the first registered
 * layer ranked strictly above it, or (for a slot under the labels) the base
 * style's first symbol layer. `undefined` means "top of the stack".
 *
 * The anchor has to compete inside the walk rather than act as a fallback after
 * it. As a fallback, a below-labels layer added while some above-labels layer
 * was already registered would anchor to that layer instead — and land above the
 * labels, because that is where the above-labels layer sits.
 */
export function resolveBeforeId(
  styleLayers: readonly StackLayer[],
  registrations: readonly LayerRegistration[],
  slot: MapLayerSlot,
  order = 0,
): string | undefined {
  const rank = layerRank(slot, order);
  const byId = new Map(registrations.map((r) => [r.id, r]));
  const belowLabels = MAP_LAYER_SLOTS.indexOf(slot) < SYMBOL_SLOT_INDEX;
  const symbolId = belowLabels ? firstSymbolLayerId(styleLayers, registrations) : undefined;
  for (const layer of styleLayers) {
    if (layer.id === symbolId) return symbolId;
    const registration = byId.get(layer.id);
    if (registration && layerRank(registration.slot, registration.order) > rank) return layer.id;
  }
  return undefined;
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
    .sort((a, b) => layerRank(a.slot, a.order) - layerRank(b.slot, b.order));
  if (present.length === 0) return [];

  const symbolId = firstSymbolLayerId(styleLayers, registrations);
  const indexOf = (id: string) => styleLayers.findIndex((layer) => layer.id === id);
  const symbolIndex = symbolId === undefined ? Number.POSITIVE_INFINITY : indexOf(symbolId);

  const ordered = present.every((r, i) => i === 0 || indexOf(present[i - 1].id) < indexOf(r.id));
  // With no base-style symbol layer to straddle, `symbolIndex` is +Infinity and
  // no above-labels layer can ever be past it — so the check could never be
  // satisfied, every call would return a non-empty plan, and `MapLayerStack`'s
  // idle handler would move layers, re-render and re-run forever. Nothing left
  // to straddle means nothing to repair.
  const straddled =
    symbolId === undefined ||
    present.every((r) => {
      const belowLabels = MAP_LAYER_SLOTS.indexOf(r.slot) < SYMBOL_SLOT_INDEX;
      return belowLabels ? indexOf(r.id) < symbolIndex : indexOf(r.id) > symbolIndex;
    });
  if (ordered && straddled) return [];

  const moves: Array<{ id: string; beforeId: string | undefined }> = [];
  let beforeId: string | undefined;
  let crossedSymbol = false;
  for (let i = present.length - 1; i >= 0; i--) {
    const registration = present[i];
    const belowLabels = MAP_LAYER_SLOTS.indexOf(registration.slot) < SYMBOL_SLOT_INDEX;
    // The walk runs top rank first. The first below-labels layer it reaches must
    // anchor to the symbol layer, not to the above-labels layer before it —
    // otherwise every layer under it inherits that anchor and the whole
    // below-labels band is stranded above the labels, which no later pass undoes.
    if (belowLabels && !crossedSymbol) {
      crossedSymbol = true;
      beforeId = symbolId;
    }
    moves.push({ id: registration.id, beforeId });
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
