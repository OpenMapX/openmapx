"use client";

import {
  type AttributionPresentation,
  type AttributionPresentationGroup,
  projectAttributionPresentations,
} from "@openmapx/core/attribution";
import { useMemo } from "react";
import { create } from "zustand";

/**
 * Registry of the credits currently owed by whatever the main map paints.
 *
 * The main map runs with MapLibre's built-in AttributionControl disabled — the
 * credits are rendered by `<MapFooter>` instead, so they can share one bar with
 * the legal links (and merge with them on narrow viewports). Layers register
 * their credits through `useMapAttributions`, keyed by layer, and this store is
 * the single place the footer reads them from.
 *
 * Entries retain separate complete/permanent notices and reviewed branding,
 * Identical notices contributed by different layers collapse into one while
 * preserving every publisher and licence link.
 */
type MapAttributionState = {
  byLayer: Record<string, AttributionPresentation[]>;
  setLayer: (layerKey: string, entries: AttributionPresentation[]) => void;
  clearLayer: (layerKey: string) => void;
};

function sameList(a: AttributionPresentation[] | undefined, b: AttributionPresentation[]): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

export const useMapAttributionStore = create<MapAttributionState>((set) => ({
  byLayer: {},
  setLayer: (layerKey, html) =>
    set((state) => {
      // Bail on no-op writes so a layer re-registering identical credits
      // doesn't re-render every subscriber.
      if (sameList(state.byLayer[layerKey], html)) return state;
      return { byLayer: { ...state.byLayer, [layerKey]: html } };
    }),
  clearLayer: (layerKey) =>
    set((state) => {
      if (!(layerKey in state.byLayer)) return state;
      const { [layerKey]: _removed, ...rest } = state.byLayer;
      return { byLayer: rest };
    }),
}));

export {
  dedupeAttributionHtml,
  projectAttributionPresentations as projectMapAttributions,
} from "@openmapx/core/attribution";

// Base-map credits lead the strip — the imagery/map data the whole view rests
// on comes first, then per-layer credits in registration order.
const BASE_LAYER_KEY = "base";
const isBaseOwner = (key: string) =>
  key === BASE_LAYER_KEY || key.startsWith(`${BASE_LAYER_KEY}::`);

/** Deduped credits for the current map, in display order. */
export function useMapAttributionPresentation(): AttributionPresentationGroup {
  const byLayer = useMapAttributionStore((s) => s.byLayer);
  return useMemo(() => {
    const keys = Object.keys(byLayer).sort((a, b) => {
      if (isBaseOwner(a) && !isBaseOwner(b)) return -1;
      if (isBaseOwner(b) && !isBaseOwner(a)) return 1;
      return 0;
    });
    return projectAttributionPresentations(keys.flatMap((key) => byLayer[key] ?? []));
  }, [byLayer]);
}
