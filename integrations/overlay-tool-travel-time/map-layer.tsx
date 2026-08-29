"use client";

import {
  type LngLat,
  TRANSIT_WALK_PROFILE,
  type TransitReachabilitySurfaceRequest,
  useIsochrone,
  useTransitReachability,
} from "@openmapx/core";
import type { MapMouseEvent } from "maplibre-gl";
import { useEffect, useMemo, useRef } from "react";
import { addLayerInSlot, unregisterLayerSlot } from "@/components/map/layers/layerStack";
import { useGeoJsonSourceDataBridge } from "@/components/map/layers/useGeoJsonSourceDataBridge";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { useMap } from "@/lib/MapContext";
import { useMapAttributions } from "@/lib/useMapAttributions";
import { resolveTravelTimeBackend, type TravelTimeMode, useTravelTimeStore } from "./store";
import { TransitFieldLayer } from "./transit-field-layer";

const SOURCE_ID = "travel-time-source";
const FILL_LAYER = "travel-time-fill";
const OUTLINE_LAYER = "travel-time-outline";
const REACH_SOURCE = "travel-time-reach-source";
const REACH_LAYER = "travel-time-reach";
const ORIGIN_SOURCE = "travel-time-origin-source";
const ORIGIN_LAYER = "travel-time-origin";
const ORIGIN_PULSE_LAYER = "travel-time-origin-pulse";
const TRANSIT_FIELD_LAYER = "travel-time-transit-field";

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
  const queryTime = useTravelTimeStore((s) => s.queryTime);
  const showTransitStops = useTravelTimeStore((s) => s.showTransitStops);
  const transitFieldUnsupported = useTravelTimeStore((s) => s.transitFieldUnsupported);
  const { publish: publishGeoJson } = useGeoJsonSourceDataBridge({
    mapRef,
    mapReady,
    styleVersion,
    visible: isActive,
  });

  const draggingRef = useRef(false);
  const transitFieldLayerRef = useRef<TransitFieldLayer | null>(null);

  const backend = resolveTravelTimeBackend(mode);
  const isTransit = backend.kind === "transit-reachability";

  const { data: isochroneData } = useIsochrone({
    origin,
    mode: backend.kind === "street-isochrone" ? backend.mode : "walking",
    contourMinutes: selectedMinutes,
    enabled: isActive && !isTransit,
  });

  const transitRequest = useMemo<TransitReachabilitySurfaceRequest | null>(() => {
    if (!origin || !queryTime || !isTransit || selectedMinutes.length === 0) return null;
    return {
      origin: { lng: origin[0], lat: origin[1] },
      queryTime,
      direction: "depart-at",
      // The server needs only the largest budget. Lower visual bands are
      // composited from the same remaining-time field without a refetch.
      thresholdsMinutes: [Math.max(...selectedMinutes)],
      walkProfileId: TRANSIT_WALK_PROFILE.id,
    };
  }, [isTransit, origin, queryTime, selectedMinutes]);
  const { data: transitSurface, attributions: transitAttributions } = useTransitReachability(
    transitRequest,
    isActive && isTransit,
  );
  useMapAttributions(
    "travel-time:street-isochrone",
    isActive && !isTransit ? (isochroneData?.attributions ?? []) : [],
  );
  useMapAttributions(
    "travel-time:transit-reachability",
    isActive && isTransit ? transitAttributions : [],
  );

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

      // `route-markers`, not an overlay band: the isochrone is the user's
      // active in-progress query — origin + contours drawn above the base
      // labels, exactly like the route's own waypoint pins.
      addLayerInSlot(
        map,
        {
          id: FILL_LAYER,
          type: "fill",
          source: SOURCE_ID,
          paint: {
            "fill-color": ["get", "color"],
            "fill-opacity": ["get", "opacity"],
          },
        },
        "route-markers",
        18,
      );

      addLayerInSlot(
        map,
        {
          id: OUTLINE_LAYER,
          type: "line",
          source: SOURCE_ID,
          paint: {
            "line-color": ["get", "color"],
            "line-width": 2,
            "line-opacity": 0.6,
          },
        },
        "route-markers",
        19,
      );

      // Optional/fallback stop diagnostics, graduated by time band.
      addLayerInSlot(
        map,
        {
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
        },
        "route-markers",
        20,
      );

      // Pulsing ring
      addLayerInSlot(
        map,
        {
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
        },
        "route-markers",
        21,
      );

      // Origin dot
      addLayerInSlot(
        map,
        {
          id: ORIGIN_LAYER,
          type: "circle",
          source: ORIGIN_SOURCE,
          paint: {
            "circle-radius": 7,
            "circle-color": ["get", "color"],
            "circle-stroke-color": "#FFFFFF",
            "circle-stroke-width": 2,
          },
        },
        "route-markers",
        22,
      );
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
        unregisterLayerSlot(id);
      }
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      if (map.getSource(REACH_SOURCE)) map.removeSource(REACH_SOURCE);
      if (map.getSource(ORIGIN_SOURCE)) map.removeSource(ORIGIN_SOURCE);
    };
  }, [mapRef, mapReady, styleVersion, isActive]);

  // Own WebGL resources for the lifetime of this style/active transit layer.
  // Data and threshold changes below update only the instance buffer.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !isActive || !isTransit) return;
    const setUnsupported = useTravelTimeStore.getState().setTransitFieldUnsupported;
    setUnsupported(null);
    const layer = new TransitFieldLayer({
      id: TRANSIT_FIELD_LAYER,
      seeds: [],
      thresholdsMinutes: [],
      onUnsupported: setUnsupported,
    });
    transitFieldLayerRef.current = layer;
    const setup = () => {
      if (!map.getLayer(TRANSIT_FIELD_LAYER)) {
        addLayerInSlot(map, layer, "route-markers", 17);
      }
    };
    if (map.isStyleLoaded()) setup();
    else map.once("styledata", setup);
    return () => {
      if (transitFieldLayerRef.current === layer) transitFieldLayerRef.current = null;
      if (map.getStyle() && map.getLayer(TRANSIT_FIELD_LAYER)) map.removeLayer(TRANSIT_FIELD_LAYER);
      unregisterLayerSlot(TRANSIT_FIELD_LAYER);
    };
  }, [isActive, isTransit, mapReady, mapRef, styleVersion]);

  // The surface is an estimated continuous field rendered from MOTIS
  // one-to-all seeds. The origin seed adds direct walking reach.
  useEffect(() => {
    void styleVersion;
    const seeds = origin
      ? [{ lng: origin[0], lat: origin[1], arrivalSeconds: 0 }, ...(transitSurface?.seeds ?? [])]
      : [];
    transitFieldLayerRef.current?.setData(seeds, selectedMinutes);
  }, [origin, selectedMinutes, styleVersion, transitSurface]);

  // Update isochrone polygons
  useEffect(() => {
    void styleVersion;
    if (!mapReady || !isActive) return;

    if (isTransit || !isochroneData || isochroneData.contours.length === 0) {
      publishGeoJson([{ sourceId: SOURCE_ID, data: { type: "FeatureCollection", features: [] } }]);
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

    publishGeoJson([{ sourceId: SOURCE_ID, data: { type: "FeatureCollection", features } }]);
  }, [isActive, isTransit, isochroneData, mapReady, publishGeoJson, styleVersion]);

  // Update transit reachability dots (one-to-all). Each reachable stop is
  // coloured by the transit mode and faded by which selected time band it falls
  // into (nearest band most opaque). Cleared whenever transit isn't selected.
  useEffect(() => {
    void styleVersion;
    if (!mapReady || !isActive) return;

    const dotsVisible = showTransitStops || transitFieldUnsupported !== null;
    if (!isTransit || !dotsVisible || !transitSurface?.seeds.length) {
      publishGeoJson([
        { sourceId: REACH_SOURCE, data: { type: "FeatureCollection", features: [] } },
      ]);
      return;
    }

    const sortedAsc = [...selectedMinutes].sort((a, b) => a - b);
    const bands = sortedAsc.length;
    const color = MODE_COLORS.transit;

    const features: GeoJSON.Feature[] = [];
    for (const seed of transitSurface.seeds) {
      const r = seed.arrivalSeconds / 60;
      const band = bandIndex(r, sortedAsc);
      if (band === -1) continue; // beyond the largest selected budget
      // Nearest band (index 0) most opaque.
      const opacity = bands <= 1 ? 0.8 : 0.85 - (band / (bands - 1)) * 0.5;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [seed.lng, seed.lat] },
        properties: { color, opacity, reachMinutes: r, name: seed.stop?.name ?? "" },
      });
    }
    publishGeoJson([{ sourceId: REACH_SOURCE, data: { type: "FeatureCollection", features } }]);
  }, [
    isActive,
    isTransit,
    mapReady,
    publishGeoJson,
    selectedMinutes,
    showTransitStops,
    styleVersion,
    transitFieldUnsupported,
    transitSurface,
  ]);

  // Update origin marker
  useEffect(() => {
    void styleVersion;
    if (!mapReady || !isActive) return;

    if (!origin) {
      publishGeoJson([
        { sourceId: ORIGIN_SOURCE, data: { type: "FeatureCollection", features: [] } },
      ]);
      return;
    }

    const color = MODE_COLORS[mode];
    publishGeoJson([
      {
        sourceId: ORIGIN_SOURCE,
        data: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: origin },
              properties: { color },
            },
          ],
        },
      },
    ]);
  }, [isActive, mapReady, mode, origin, publishGeoJson, styleVersion]);

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
