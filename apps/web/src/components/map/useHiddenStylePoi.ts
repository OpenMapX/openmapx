"use client";

import type { LngLat } from "@openmapx/core";
import type { FilterSpecification } from "maplibre-gl";
import { useEffect } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import {
  filterWithoutFeature,
  findStylePoiFeatureId,
  getStylePoiLayerIds,
} from "./mapStylePoiTarget";

export interface HiddenStylePoiPlace {
  coordinates: LngLat;
  /** Every name the place goes by; the basemap POI matches on any of them. */
  names: readonly string[];
  /** Tile feature id when the place came from a click on the basemap POI. */
  stylePoiId?: string;
}

function sameFilter(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Hides the basemap's own POI icon and label for the selected place while it
 * is selected, so the place is marked once — by its pin — instead of by the
 * pin plus the map's label beside it.
 *
 * The POI is left out through its layers' filters and restored on
 * deselection. Filters a style swap resets are narrowed again on `styledata`;
 * a POI whose tile has not loaded yet is looked up again on `idle`.
 */
export function useHiddenStylePoi(place: HiddenStylePoiPlace | null) {
  const { mapRef, mapReady, styleVersion } = useMap();
  const lng = place?.coordinates[0];
  const lat = place?.coordinates[1];
  const stylePoiId = place?.stylePoiId;
  const namesKey = place ? JSON.stringify(place.names) : "";

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || lng === undefined || lat === undefined) return;
    const names: string[] = namesKey ? JSON.parse(namesKey) : [];

    const narrowed = new Map<
      string,
      { original: FilterSpecification | undefined; applied: FilterSpecification }
    >();
    let featureId: number | null = null;

    const apply = () => {
      if (featureId === null) return;
      for (const layerId of getStylePoiLayerIds(map)) {
        const current = map.getFilter(layerId) ?? undefined;
        const entry = narrowed.get(layerId);
        if (entry && sameFilter(current, entry.applied)) continue;
        const applied = filterWithoutFeature(current, featureId);
        narrowed.set(layerId, { original: current, applied });
        map.setFilter(layerId, applied);
      }
    };

    const resolve = () => {
      if (featureId !== null) return;
      featureId = findStylePoiFeatureId(map, getStylePoiLayerIds(map), {
        coordinates: [lng, lat],
        names,
        stylePoiId,
      });
      apply();
    };

    resolve();
    map.on("styledata", apply);
    map.on("idle", resolve);
    return () => {
      map.off("styledata", apply);
      map.off("idle", resolve);
      for (const [layerId, { original, applied }] of narrowed) {
        if (!map.getLayer(layerId) || !sameFilter(map.getFilter(layerId), applied)) continue;
        map.setFilter(layerId, original ?? null);
      }
    };
  }, [mapRef, mapReady, styleVersion, lng, lat, stylePoiId, namesKey]);
}
