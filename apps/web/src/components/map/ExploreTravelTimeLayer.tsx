"use client";

import type { IsochroneTravelMode } from "@openmapx/core";
import { useCategorySearchStore, useIsochrone } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";

const SOURCE_ID = "explore-travel-time-source";
const FILL_LAYER = "explore-travel-time-fill";
const OUTLINE_LAYER = "explore-travel-time-outline";

const MODE_COLORS: Record<IsochroneTravelMode, string> = {
  driving: "#1A73E8",
  walking: "#34A853",
  cycling: "#F9AB00",
};

export function ExploreTravelTimeLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const anchor = useCategorySearchStore((s) => s.anchor);
  const travelTime = useCategorySearchStore((s) => s.travelTime);

  const active = travelTime.enabled && anchor !== null;

  const { data: isochroneData } = useIsochrone({
    origin: anchor?.coordinates ?? null,
    mode: travelTime.mode,
    contourMinutes: [travelTime.minutes],
    enabled: active,
  });

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !active) return;

    const setup = () => {
      if (map.getSource(SOURCE_ID)) return;
      const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
      map.addSource(SOURCE_ID, { type: "geojson", data: empty });
      map.addLayer({
        id: FILL_LAYER,
        type: "fill",
        source: SOURCE_ID,
        paint: { "fill-color": ["get", "color"], "fill-opacity": 0.18 },
      });
      map.addLayer({
        id: OUTLINE_LAYER,
        type: "line",
        source: SOURCE_ID,
        paint: { "line-color": ["get", "color"], "line-width": 2, "line-opacity": 0.6 },
      });
    };

    if (map.isStyleLoaded()) setup();
    else map.once("styledata", setup);

    return () => {
      map.off("styledata", setup);
      if (!map.getStyle()) return;
      if (map.getLayer(OUTLINE_LAYER)) map.removeLayer(OUTLINE_LAYER);
      if (map.getLayer(FILL_LAYER)) map.removeLayer(FILL_LAYER);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    };
  }, [mapRef, mapReady, styleVersion, active]);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !active) return;
    const src = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    if (!isochroneData || isochroneData.contours.length === 0) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    const color = MODE_COLORS[isochroneData.mode];
    src.setData({
      type: "FeatureCollection",
      features: isochroneData.contours.map((c) => ({
        type: "Feature",
        geometry: c.geometry as GeoJSON.Geometry,
        properties: { color },
      })),
    });
  }, [mapRef, mapReady, styleVersion, active, isochroneData]);

  return null;
}
