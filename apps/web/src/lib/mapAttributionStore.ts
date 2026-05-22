"use client";

import type { Attribution } from "@openmapx/mobility-core/attribution";
import { useEffect, useMemo } from "react";
import { create } from "zustand";

interface MapAttributionStoreState {
  /**
   * Layer-keyed attribution contributions. Keys are caller-chosen stable IDs
   * (typically the integration id, a hand-rolled layer id, or `provider.id`).
   *
   * Insertion order is preserved by JS object semantics and that order is what
   * `selectFlattened` consumes — first-mounted layer's sources render before
   * later layers.
   */
  entries: Record<string, Attribution[]>;
  set: (layerKey: string, attributions: Attribution[]) => void;
  remove: (layerKey: string) => void;
}

/**
 * Active-attribution store. Every map layer that wants to participate in the
 * footer attribution strip registers its contribution while mounted and
 * removes it on unmount. The store is the single source of truth that
 * `<MapAttributionStrip>` reads from.
 */
export const useMapAttributionStore = create<MapAttributionStoreState>((set) => ({
  entries: {},
  set: (layerKey, attributions) =>
    set((state) => {
      const previous = state.entries[layerKey];
      if (
        previous &&
        previous.length === attributions.length &&
        previous.every((a, i) => a === attributions[i])
      ) {
        return state;
      }
      return { entries: { ...state.entries, [layerKey]: attributions } };
    }),
  remove: (layerKey) =>
    set((state) => {
      if (!(layerKey in state.entries)) return state;
      const next = { ...state.entries };
      delete next[layerKey];
      return { entries: next };
    }),
}));

/**
 * Flatten entries across all registered layers, preserving:
 *   - layer registration order (first-mounted layer comes first)
 *   - within-layer order (manifest-curated sources before runtime/license rows)
 * Deduplicates by `sourceId` so the same source registered by multiple layers
 * appears once.
 */
export function flattenAttributions(entries: Record<string, Attribution[]>): Attribution[] {
  const seen = new Set<string>();
  const out: Attribution[] = [];
  for (const list of Object.values(entries)) {
    for (const attr of list) {
      if (!attr?.sourceId || seen.has(attr.sourceId)) continue;
      seen.add(attr.sourceId);
      out.push(attr);
    }
  }
  return out;
}

/**
 * Hook for layer components: register `attributions` under `layerKey` while
 * the component is mounted; clean up on unmount or layerKey change.
 *
 * Passing an empty array is fine — the layer key is still tracked (and is a
 * no-op for rendering), which is useful when a layer has no static attribution
 * to declare but might later set one based on data.
 */
export function useRegisterMapAttribution(
  layerKey: string | null | undefined,
  attributions: Attribution[],
): void {
  // Memoize on shallow equality of contents so callers can pass freshly-built
  // arrays without churning the store.
  const stable = useStableAttributions(attributions);
  useEffect(() => {
    if (!layerKey) return;
    useMapAttributionStore.getState().set(layerKey, stable);
    return () => {
      useMapAttributionStore.getState().remove(layerKey);
    };
  }, [layerKey, stable]);
}

function useStableAttributions(attributions: Attribution[]): Attribution[] {
  // biome-ignore lint/correctness/useExhaustiveDependencies: hash captures contents
  return useMemo(
    () => attributions,
    [
      attributions.length,
      attributions
        .map((a) => `${a.sourceId}|${a.name}|${a.url ?? ""}|${a.spdxLicense ?? ""}`)
        .join("\n"),
    ],
  );
}
