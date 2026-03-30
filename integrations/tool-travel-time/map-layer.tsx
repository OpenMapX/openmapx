"use client";

import type { IsochroneTravelMode, LngLat } from "@openmapx/core";
import { useIsochrone, useTravelTimeStore } from "@openmapx/core";
import type { MapMouseEvent } from "maplibre-gl";
import { useEffect, useRef } from "react";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { useMap } from "@/lib/MapContext";

const SOURCE_ID = "travel-time-source";
const FILL_LAYER = "travel-time-fill";
const OUTLINE_LAYER = "travel-time-outline";
const ORIGIN_SOURCE = "travel-time-origin-source";
const ORIGIN_LAYER = "travel-time-origin";
const ORIGIN_PULSE_LAYER = "travel-time-origin-pulse";

const LAYER_IDS = [FILL_LAYER, OUTLINE_LAYER, ORIGIN_LAYER, ORIGIN_PULSE_LAYER];

const MODE_COLORS: Record<IsochroneTravelMode, string> = {
  driving: "#1A73E8",
  walking: "#34A853",
  cycling: "#F9AB00",
};

function computeOpacity(index: number, total: number): number {
  if (total <= 1) return 0.2;
  const maxOpacity = 0.25;
  const minOpacity = 0.08;
  const t = (total - 1 - index) / (total - 1);
  return minOpacity + t * (maxOpacity - minOpacity);
}

export function TravelTimeLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const isActive = useTravelTimeStore((s) => s.isActive);
  const origin = useTravelTimeStore((s) => s.origin);
  const mode = useTravelTimeStore((s) => s.mode);
  const selectedMinutes = useTravelTimeStore((s) => s.selectedMinutes);

  const draggingRef = useRef(false);

  const { data: isochroneData } = useIsochrone({
    origin,
    mode,
    contourMinutes: selectedMinutes,
    enabled: isActive,
  });

  // Register interactive layers
  useEffect(() => {
    if (!isActive) return;
    for (const id of LAYER_IDS) INTERACTIVE_LAYER_IDS.add(id);
    return () => {
      for (const id of LAYER_IDS) INTERACTIVE_LAYER_IDS.delete(id);
    };
  }, [isActive]);

  // Set up sources and layers
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !isActive) return;

    const setup = () => {
      if (map.getSource(SOURCE_ID)) return;

      const emptyFC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

      map.addSource(SOURCE_ID, { type: "geojson", data: emptyFC });
      map.addSource(ORIGIN_SOURCE, { type: "geojson", data: emptyFC });

      map.addLayer({
        id: FILL_LAYER,
        type: "fill",
        source: SOURCE_ID,
        paint: {
          "fill-color": ["get", "color"],
          "fill-opacity": ["get", "opacity"],
        },
      });

      map.addLayer({
        id: OUTLINE_LAYER,
        type: "line",
        source: SOURCE_ID,
        paint: {
          "line-color": ["get", "color"],
          "line-width": 2,
          "line-opacity": 0.6,
        },
      });

      // Pulsing ring
      map.addLayer({
        id: ORIGIN_PULSE_LAYER,
        type: "circle",
        source: ORIGIN_SOURCE,
        paint: {
          "circle-radius": 14,
          "circle-color": "transparent",
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-width": 2,
          "circle-stroke-opacity": 0.3,
        },
      });

      // Origin dot
      map.addLayer({
        id: ORIGIN_LAYER,
        type: "circle",
        source: ORIGIN_SOURCE,
        paint: {
          "circle-radius": 7,
          "circle-color": ["get", "color"],
          "circle-stroke-color": "#FFFFFF",
          "circle-stroke-width": 2,
        },
      });
    };

    if (map.isStyleLoaded()) {
      setup();
    } else {
      map.once("styledata", setup);
    }

    return () => {
      if (!map.getStyle()) return;
      for (const id of [ORIGIN_LAYER, ORIGIN_PULSE_LAYER, OUTLINE_LAYER, FILL_LAYER]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      if (map.getSource(ORIGIN_SOURCE)) map.removeSource(ORIGIN_SOURCE);
    };
  }, [mapRef, mapReady, styleVersion, isActive]);

  // Update isochrone polygons
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !isActive) return;

    const src = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    if (!isochroneData || isochroneData.contours.length === 0) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const color = MODE_COLORS[isochroneData.mode];
    const total = isochroneData.contours.length;

    // Render outermost first (lowest z), innermost last (highest z)
    const features: GeoJSON.Feature[] = [...isochroneData.contours]
      .sort((a, b) => b.time - a.time)
      .map((contour, i) => ({
        type: "Feature",
        geometry: contour.geometry,
        properties: {
          color,
          opacity: computeOpacity(i, total),
          time: contour.time,
        },
      }));

    src.setData({ type: "FeatureCollection", features });
  }, [mapRef, mapReady, styleVersion, isActive, isochroneData]);

  // Update origin marker
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !isActive) return;

    const src = map.getSource(ORIGIN_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    if (!origin) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const color = MODE_COLORS[mode];
    src.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: origin },
          properties: { color },
        },
      ],
    });
  }, [mapRef, mapReady, styleVersion, isActive, origin, mode]);

  // Click handler to set origin
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !isActive) return;

    const onClick = (e: MapMouseEvent) => {
      const lngLat: LngLat = [e.lngLat.lng, e.lngLat.lat];
      useTravelTimeStore.getState().setOrigin(lngLat);
    };

    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [mapRef, mapReady, styleVersion, isActive]);

  // Origin marker drag
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !isActive) return;

    const onMouseDown = (e: MapMouseEvent) => {
      const features = map.queryRenderedFeatures(e.point, { layers: [ORIGIN_LAYER] });
      if (features.length === 0) return;

      draggingRef.current = true;
      map.getCanvas().style.cursor = "grabbing";
      map.dragPan.disable();
      e.preventDefault();
    };

    const onMouseMove = (e: MapMouseEvent) => {
      if (!draggingRef.current) {
        const features = map.queryRenderedFeatures(e.point, { layers: [ORIGIN_LAYER] });
        map.getCanvas().style.cursor =
          features.length > 0 ? "pointer" : isActive ? "crosshair" : "";
        return;
      }
      const lngLat: LngLat = [e.lngLat.lng, e.lngLat.lat];
      useTravelTimeStore.getState().setOrigin(lngLat);
    };

    const onMouseUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      map.getCanvas().style.cursor = "crosshair";
      map.dragPan.enable();
    };

    map.on("mousedown", onMouseDown);
    map.on("mousemove", onMouseMove);
    map.on("mouseup", onMouseUp);

    return () => {
      map.off("mousedown", onMouseDown);
      map.off("mousemove", onMouseMove);
      map.off("mouseup", onMouseUp);
      if (draggingRef.current) {
        map.dragPan.enable();
        draggingRef.current = false;
      }
    };
  }, [mapRef, mapReady, styleVersion, isActive]);

  // Cursor management
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (isActive) {
      map.getCanvas().style.cursor = "crosshair";
    } else {
      map.getCanvas().style.cursor = "";
    }

    return () => {
      map.getCanvas().style.cursor = "";
    };
  }, [mapRef, isActive]);

  // Keyboard: Escape to deactivate
  useEffect(() => {
    if (!isActive) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        return;

      if (e.key === "Escape") {
        e.preventDefault();
        useTravelTimeStore.getState().deactivate();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isActive]);

  return null;
}
