"use client";

import { parseAttributionHtml } from "@openmapx/core/attribution";
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
 * Identical notices contributed by different layers collapse into one while
 * preserving every publisher and licence link.
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
 * Keep MapLibre's containment rule and also compare parsed notices: a linked
 * basemap notice can cover an overlay's plain copy of the same wording. Only
 * discard that copy if the retained notice preserves every link, including
 * its label and target. Equal link sets keep the first occurrence; distinct or
 * complementary licence/publisher links remain separate.
 */
export function dedupeAttributionHtml(items: string[]): string[] {
  const notices = items.map((html) => ({ html, ...parseAttributionHtml(html) }));
  type Notice = (typeof notices)[number];
  const coversLinks = (candidate: Notice, original: Notice) =>
    original.links.every((link) =>
      candidate.links.some((other) => other.label === link.label && other.url === link.url),
    );
  return notices
    .filter(
      (notice, i) =>
        notice.html.length > 0 &&
        !notices.some((other, j) => {
          if (j === i) return false;
          if (notice.text === other.text) {
            return coversLinks(other, notice) && (!coversLinks(notice, other) || j < i);
          }
          return (
            other.html.includes(notice.html) && (other.html.length > notice.html.length || j < i)
          );
        }),
    )
    .map(({ html }) => html);
}

// Base-map credits lead the strip — the imagery/map data the whole view rests
// on comes first, then per-layer credits in registration order.
const BASE_LAYER_KEY = "base";
const isBaseOwner = (key: string) =>
  key === BASE_LAYER_KEY || key.startsWith(`${BASE_LAYER_KEY}::`);

/** Deduped credits for the current map, in display order. */
export function useMapAttributionHtml(): string[] {
  const byLayer = useMapAttributionStore((s) => s.byLayer);
  return useMemo(() => {
    const keys = Object.keys(byLayer).sort((a, b) => {
      if (isBaseOwner(a) && !isBaseOwner(b)) return -1;
      if (isBaseOwner(b) && !isBaseOwner(a)) return 1;
      return 0;
    });
    return dedupeAttributionHtml(keys.flatMap((key) => byLayer[key] ?? []));
  }, [byLayer]);
}
