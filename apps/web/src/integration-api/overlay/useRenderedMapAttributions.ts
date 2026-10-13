"use client";

import { useEffect, useId } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { useMapAttributionStore } from "./mapAttributionStore";
import {
  type RenderedMapAttributionOptions,
  renderedMapAttributionTracker,
} from "./renderedMapAttributionTracker";

export type { RenderedMapAttributionOptions } from "./renderedMapAttributionTracker";

/**
 * Register captured credits only for features actually rendered in this viewport.
 * Independently hidden/placed icon and text channels need separate query layers:
 * queryRenderedFeatures does not identify which symbol channel matched a hit.
 */
export function useRenderedMapAttributions(
  layerKey: string,
  layerIds: readonly string[],
  visible: boolean,
  options?: RenderedMapAttributionOptions,
): void {
  const { mapRef, mapReady, styleVersion } = useMap();
  const map = mapRef.current;
  const instance = useId();
  const owner = `rendered:${layerKey}::${instance}`;
  const setLayer = useMapAttributionStore((s) => s.setLayer);
  const clearLayer = useMapAttributionStore((s) => s.clearLayer);
  const subscription = {
    kind: "geometry" as const,
    ...options,
    layerIds,
    publish: (html: string[]) => (html.length ? setLayer(owner, html) : clearLayer(owner)),
  };

  // The registration lifetime follows the map/owner, while changing receipt
  // snapshots and resolver closures update the existing shared scheduler.
  // biome-ignore lint/correctness/useExhaustiveDependencies: subscription updates in the effect below
  useEffect(() => {
    void styleVersion;
    clearLayer(owner);
    if (!map || !mapReady || !visible) return;
    return renderedMapAttributionTracker(map).subscribe(owner, subscription);
  }, [map, mapReady, styleVersion, visible, owner, clearLayer]);

  useEffect(() => {
    if (map && mapReady && visible) renderedMapAttributionTracker(map).update(owner, subscription);
  });
}
