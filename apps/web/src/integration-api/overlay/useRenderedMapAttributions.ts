"use client";

import type { Attribution } from "@openmapx/mobility-core/attribution";
import { useEffect } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { useMapAttributionStore } from "./mapAttributionStore";
import { attributionToHtml } from "./useMapAttributions";

const REFRESH_INTERVAL_MS = 250;

/** Decode the credit snapshot transported in a rendered GeoJSON feature. */
function creditHtml(payload: string): string[] {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((raw): string[] => {
      if (
        !raw ||
        typeof raw !== "object" ||
        typeof raw.sourceId !== "string" ||
        typeof raw.name !== "string"
      )
        return [];
      const credit: Attribution = { sourceId: raw.sourceId, name: raw.name };
      for (const field of ["url", "spdxLicense", "licenseUrl", "attributionText"] as const) {
        if (typeof raw[field] === "string") credit[field] = raw[field];
      }
      return [attributionToHtml(credit)];
    });
  } catch {
    return [];
  }
}

/**
 * Credits from `_mapAttributions` on features actually rendered in the map
 * viewport. MapLibre applies the layer filters, zoom ranges and symbol
 * placement before returning them. Use a separate owner for each layer group.
 */
export function useRenderedMapAttributions(
  layerKey: string,
  layerIds: readonly string[],
  visible: boolean,
): void {
  const { mapRef, mapReady, styleVersion } = useMap();
  const setLayer = useMapAttributionStore((s) => s.setLayer);
  const clearLayer = useMapAttributionStore((s) => s.clearLayer);

  useEffect(() => {
    void styleVersion;
    const owner = `rendered:${layerKey}`;
    const map = mapRef.current;
    clearLayer(owner);
    if (!map || !mapReady || !visible) return;
    let disposed = false;
    let lastQueryAt = Number.NEGATIVE_INFINITY;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let decoded = new Map<string, string[]>();

    const refresh = () => {
      timer = undefined;
      if (disposed) return;
      lastQueryAt = performance.now();
      // isStyleLoaded() waits for every source's tiles/images, even unrelated
      // ones. Existing incidents remain queryable while those are loading.
      // A true style teardown instead leaves no incident layers to query.
      const zoom = map.getZoom();
      const layers = layerIds.filter((id) => {
        const layer = map.getLayer(id);
        return (
          layer &&
          zoom >= (layer.minzoom ?? 0) &&
          zoom < (layer.maxzoom ?? 24) &&
          map.getLayoutProperty(id, "visibility") !== "none"
        );
      });
      const html = new Set<string>();
      const nextDecoded = new Map<string, string[]>();
      if (layers.length > 0) {
        // Undefined geometry means the whole viewport, including clipped lines
        // whose representative incident marker is outside it.
        for (const feature of map.queryRenderedFeatures(undefined, { layers })) {
          const layer = feature.layer;
          if (
            (layer?.type === "line" && layer.paint?.["line-opacity"] === 0) ||
            (layer?.type === "symbol" && layer.paint?.["icon-opacity"] === 0)
          )
            continue;
          const payload: unknown = feature.properties?._mapAttributions;
          if (typeof payload !== "string") continue;
          let entries = nextDecoded.get(payload) ?? decoded.get(payload);
          if (!entries) entries = creditHtml(payload);
          nextDecoded.set(payload, entries);
          for (const entry of entries) if (entry) html.add(entry);
        }
      }
      decoded = nextDecoded;
      // Stable ordering prevents harmless tile/feature order changes from
      // rewriting the store (and resizing the footer) on a navigation frame.
      if (html.size > 0) setLayer(owner, [...html].sort());
      else clearLayer(owner);
    };
    const onRender = () => {
      if (timer !== undefined) return;
      timer = setTimeout(
        refresh,
        Math.max(0, REFRESH_INTERVAL_MS - (performance.now() - lastQueryAt)),
      );
    };
    // Placement can change on render frames without a move/source event, and
    // pending unrelated tiles can prevent idle indefinitely. Check every
    // rendered frame at most four times per second; no recurring timer remains
    // once rendering stops. Idle also covers the final settled placement.
    map.on("render", onRender);
    map.on("idle", onRender);
    onRender();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      map.off("render", onRender);
      map.off("idle", onRender);
      clearLayer(owner);
    };
  }, [mapRef, mapReady, styleVersion, visible, layerKey, layerIds, setLayer, clearLayer]);
}
