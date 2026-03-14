"use client";

import { useDirections, useDirectionsStore } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";
import { PRIMARY_BLUE } from "@/lib/theme";

type GeoJSONSource = maplibregl.GeoJSONSource;

const SOURCE_ID = "route-source";
const LAYER_ALT_CASING = "route-alt-casing";
const LAYER_ALT_LINE = "route-alt-line";
const LAYER_ACTIVE_CASING = "route-active-casing";
const LAYER_ACTIVE_LINE = "route-active-line";

export function RouteLayer() {
  const { mapRef, mapReady, fitBounds } = useMap();
  const {
    origin,
    destination,
    mode,
    activeRouteIndex,
    setActiveRouteIndex,
    avoidHighways,
    avoidTolls,
    avoidFerries,
    units,
  } = useDirectionsStore();

  const { data } = useDirections({
    origin,
    destination,
    mode,
    avoidHighways,
    avoidTolls,
    avoidFerries,
    units,
  });

  // Add map source and layers — must wait for the style to finish loading
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const setup = () => {
      if (map.getSource(SOURCE_ID)) return;

      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      // Alt routes — casing (white outline below)
      map.addLayer({
        id: LAYER_ALT_CASING,
        type: "line",
        source: SOURCE_ID,
        filter: ["==", ["get", "type"], "alt"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.6 },
      });

      // Alt routes — colored line
      map.addLayer({
        id: LAYER_ALT_LINE,
        type: "line",
        source: SOURCE_ID,
        filter: ["==", ["get", "type"], "alt"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#93C5FD", "line-width": 5, "line-opacity": 0.75 },
      });

      // Active route — casing
      map.addLayer({
        id: LAYER_ACTIVE_CASING,
        type: "line",
        source: SOURCE_ID,
        filter: ["==", ["get", "type"], "active"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#ffffff", "line-width": 10 },
      });

      // Active route — colored line (on top)
      map.addLayer({
        id: LAYER_ACTIVE_LINE,
        type: "line",
        source: SOURCE_ID,
        filter: ["==", ["get", "type"], "active"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": PRIMARY_BLUE, "line-width": 7 },
      });

      // Click on alt route to select it
      map.on("click", LAYER_ALT_LINE, onClick);
      map.on("mouseenter", LAYER_ALT_LINE, onEnter);
      map.on("mouseleave", LAYER_ALT_LINE, onLeave);
    };

    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      const features = e.features;
      if (features?.[0]) {
        const idx = features[0].properties?.routeIndex as number | undefined;
        if (idx !== undefined) setActiveRouteIndex(idx);
      }
    };
    const onEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = "";
    };

    if (map.isStyleLoaded()) {
      setup();
    } else {
      map.once("load", setup);
    }
    return () => {
      map.off("load", setup);
      map.off("click", LAYER_ALT_LINE, onClick);
      map.off("mouseenter", LAYER_ALT_LINE, onEnter);
      map.off("mouseleave", LAYER_ALT_LINE, onLeave);
    };
  }, [mapRef, mapReady, setActiveRouteIndex]);

  // Update source data whenever routes change
  useEffect(() => {
    const map = mapRef.current;
    const raw = map?.getSource(SOURCE_ID);
    if (!raw || raw.type !== "geojson") return;
    const source = raw as GeoJSONSource;

    // Don't show driving/cycling/walking routes when in transit mode
    if (mode === "transit") {
      source.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    if (!data || data.routes.length === 0) {
      source.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const features = data.routes.map((route, i) => ({
      type: "Feature" as const,
      properties: {
        type: i === activeRouteIndex ? "active" : "alt",
        routeIndex: i,
      },
      geometry: {
        type: "LineString" as const,
        coordinates: route.geometry,
      },
    }));

    // Put active route last so it renders on top
    features.sort((a) => (a.properties.type === "active" ? 1 : -1));

    (source as GeoJSONSource).setData({ type: "FeatureCollection", features });

    // Fit map to active route bounds
    const activeGeom = data.routes[activeRouteIndex]?.geometry;
    if (activeGeom && activeGeom.length >= 2) {
      let minLng = activeGeom[0][0];
      let maxLng = activeGeom[0][0];
      let minLat = activeGeom[0][1];
      let maxLat = activeGeom[0][1];
      for (const [lng, lat] of activeGeom) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
      fitBounds(
        [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
        80,
      );
    }
  }, [data, activeRouteIndex, mode, mapRef, fitBounds]);

  // Clear routes when directions panel is closed
  useEffect(() => {
    if (!origin && !destination) {
      const map = mapRef.current;
      const raw = map?.getSource(SOURCE_ID);
      if (raw && raw.type === "geojson") {
        (raw as GeoJSONSource).setData({ type: "FeatureCollection", features: [] });
      }
    }
  }, [origin, destination, mapRef]);

  return null;
}
