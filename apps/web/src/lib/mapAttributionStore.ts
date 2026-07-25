"use client";

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
 * Entries are pre-rendered, sanitized HTML strings (see `useMapAttributions`),
 * which keeps the substring dedup below working the way MapLibre's control did:
 * identical credits contributed by different layers collapse into one.
 */
type MapAttributionState = {
  byLayer: Record<string, string[]>;
  setLayer: (layerKey: string, html: string[]) => void;
  clearLayer: (layerKey: string) => void;
};

function sameList(a: string[] | undefined, b: string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((item, i) => item === b[i]);
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

/**
 * MapLibre's AttributionControl dedup, reimplemented: drop any credit that is
 * contained in another one, keeping the longest form. Exact duplicates keep
 * their first occurrence. This is what lets a base style and an overlay both
 * credit OpenStreetMap without the strip saying it twice.
 */
export function dedupeAttributionHtml(items: string[]): string[] {
  return items.filter(
    (html, i) =>
      html.length > 0 &&
      !items.some(
        (other, j) =>
          j !== i &&
          other.includes(html) &&
          // Between two equal strings, the earlier index wins.
          (other.length > html.length || j < i),
      ),
  );
}

// Base-map credits lead the strip — the imagery/map data the whole view rests
// on comes first, then per-layer credits in registration order.
const BASE_LAYER_KEY = "base";

/** Deduped credits for the current map, in display order. */
export function useMapAttributionHtml(): string[] {
  const byLayer = useMapAttributionStore((s) => s.byLayer);
  return useMemo(() => {
    const keys = Object.keys(byLayer).sort((a, b) => {
      if (a === BASE_LAYER_KEY) return -1;
      if (b === BASE_LAYER_KEY) return 1;
      return 0;
    });
    return dedupeAttributionHtml(keys.flatMap((key) => byLayer[key] ?? []));
  }, [byLayer]);
}
