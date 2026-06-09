"use client";

import type { LngLat } from "@openmapx/core";
import { useIsochrone, useReachableStops } from "@openmapx/core";
import type { MapMouseEvent } from "maplibre-gl";
import { useEffect, useRef } from "react";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { useMap } from "@/lib/MapContext";
import { useIntegrationAttribution } from "@/lib/useIntegrationAttribution";
import { resolveIsochroneMode, type TravelTimeMode, useTravelTimeStore } from "./store";

const SOURCE_ID = "travel-time-source";
const FILL_LAYER = "travel-time-fill";
const OUTLINE_LAYER = "travel-time-outline";
const REACH_SOURCE = "travel-time-reach-source";
const REACH_LAYER = "travel-time-reach";
const ORIGIN_SOURCE = "travel-time-origin-source";
const ORIGIN_LAYER = "travel-time-origin";
const ORIGIN_PULSE_LAYER = "travel-time-origin-pulse";

const LAYER_IDS = [FILL_LAYER, OUTLINE_LAYER, REACH_LAYER, ORIGIN_LAYER, ORIGIN_PULSE_LAYER];

const MODE_COLORS: Record<TravelTimeMode, string> = {
  driving: "#1A73E8",
  walking: "#34A853",
  cycling: "#F9AB00",
  transit: "#6F42C1",
};

/** Smallest selected band (ascending) a reach time falls into, or -1 if beyond all. */
function bandIndex(reachMinutes: number, sortedAsc: number[]): number {
  for (let i = 0; i < sortedAsc.length; i++) {
    if (reachMinutes <= sortedAsc[i]) return i;
  }
  return -1;
}

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
  const anchored = useTravelTimeStore((s) => s.anchored);

  const draggingRef = useRef(false);

  // Credit the Valhalla/OSM routing source whenever the isochrone overlay is on
  // the map (manifest declares "Routing © Stadia Maps, © OpenStreetMap contributors").
  useIntegrationAttribution("overlay-tool-travel-time", isActive);

  const { isTransit, isochroneMode } = resolveIsochroneMode(mode);
  const maxMinutes = selectedMinutes.length ? Math.max(...selectedMinutes) : 30;

  const { data: isochroneData } = useIsochrone({
    origin,
    mode: isochroneMode,
    contourMinutes: selectedMinutes,
    enabled: isActive && !isTransit,
  });

  const { data: reachableStops } = useReachableStops({
    origin,
    maxMinutes,
    enabled: isActive && isTransit,
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
      map.addSource(REACH_SOURCE, { type: "geojson", data: emptyFC });
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

      // Transit reachability: one dot per reachable stop, graduated by time band.
      map.addLayer({
        id: REACH_LAYER,
        type: "circle",
        source: REACH_SOURCE,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 3, 13, 5, 16, 7],
          "circle-color": ["get", "color"],
          "circle-opacity": ["get", "opacity"],
          "circle-stroke-color": "#FFFFFF",
          "circle-stroke-width": 0.5,
          "circle-stroke-opacity": ["get", "opacity"],
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
      for (const id of [ORIGIN_LAYER, ORIGIN_PULSE_LAYER, REACH_LAYER, OUTLINE_LAYER, FILL_LAYER]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      if (map.getSource(REACH_SOURCE)) map.removeSource(REACH_SOURCE);
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

  // Update transit reachability dots (one-to-all). Each reachable stop is
  // coloured by the transit mode and faded by which selected time band it falls
  // into (nearest band most opaque). Cleared whenever transit isn't selected.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !isActive) return;

    const src = map.getSource(REACH_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    if (!isTransit || !reachableStops?.length) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const sortedAsc = [...selectedMinutes].sort((a, b) => a - b);
    const bands = sortedAsc.length;
    const color = MODE_COLORS.transit;

    const features: GeoJSON.Feature[] = [];
    for (const stop of reachableStops) {
      const r = stop.reachMinutes;
      if (r == null) continue;
      const band = bandIndex(r, sortedAsc);
      if (band === -1) continue; // beyond the largest selected budget
      // Nearest band (index 0) most opaque.
      const opacity = bands <= 1 ? 0.8 : 0.85 - (band / (bands - 1)) * 0.5;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [stop.lng, stop.lat] },
        properties: { color, opacity, reachMinutes: r, name: stop.name },
      });
    }
    src.setData({ type: "FeatureCollection", features });
  }, [mapRef, mapReady, styleVersion, isActive, isTransit, reachableStops, selectedMinutes]);

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

  // Click handler to set origin — disabled in anchored mode (e.g. Explore), where
  // the origin is the searched place and a global click would hijack marker clicks.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !isActive || anchored) return;

    const onClick = (e: MapMouseEvent) => {
      const lngLat: LngLat = [e.lngLat.lng, e.lngLat.lat];
      useTravelTimeStore.getState().setOrigin(lngLat);
    };

    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [mapRef, mapReady, styleVersion, isActive, anchored]);

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
          features.length > 0 ? "pointer" : isActive && !anchored ? "crosshair" : "";
        return;
      }
      const lngLat: LngLat = [e.lngLat.lng, e.lngLat.lat];
      useTravelTimeStore.getState().setOrigin(lngLat);
    };

    const onMouseUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      map.getCanvas().style.cursor = anchored ? "" : "crosshair";
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
  }, [mapRef, mapReady, styleVersion, isActive, anchored]);

  // Cursor management — crosshair only when click-to-place is available (not anchored).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (isActive && !anchored) {
      map.getCanvas().style.cursor = "crosshair";
    } else {
      map.getCanvas().style.cursor = "";
    }

    return () => {
      map.getCanvas().style.cursor = "";
    };
  }, [mapRef, isActive, anchored]);

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
