"use client";
import type { AttributionPresentation } from "@openmapx/core/attribution";
import { useEffect, useId } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { useMapAttributionStore } from "./mapAttributionStore";
import {
  type RasterAttributionDescriptor,
  renderedMapAttributionTracker,
} from "./renderedMapAttributionTracker";

export type { RasterAttributionDescriptor } from "./renderedMapAttributionTracker";
/** Credits a mounted raster supplier only while its successful content renders. */
export function useRasterMapAttributions(
  key: string,
  descriptors: readonly RasterAttributionDescriptor[],
  visible: boolean,
): void {
  const { mapRef, mapReady, styleVersion } = useMap();
  const map = mapRef.current;
  const instance = useId();
  const owner = `raster:${key}::${instance}`;
  const setLayer = useMapAttributionStore((s) => s.setLayer);
  const clearLayer = useMapAttributionStore((s) => s.clearLayer);
  const subscription = {
    kind: "raster" as const,
    descriptors,
    publish: (html: AttributionPresentation[]) =>
      html.length ? setLayer(owner, html) : clearLayer(owner),
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: descriptor snapshots update in the effect below
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
