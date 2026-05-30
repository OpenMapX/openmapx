"use client";

import type { LngLat } from "@openmapx/core";
import { useDirections, useDirectionsStore } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useEffect, useMemo } from "react";
import { useMap } from "@/lib/MapContext";
import { PRIMARY_BLUE_HEX } from "@/lib/theme";

type GeoJSONSource = maplibregl.GeoJSONSource;

const SOURCE_ID = "route-source";
const LAYER_ALT_CASING = "route-alt-casing";
const LAYER_ALT_LINE = "route-alt-line";
const LAYER_ACTIVE_CASING = "route-active-casing";
const LAYER_ACTIVE_LINE = "route-active-line";

export function RouteLayer() {
  const { mapRef, mapReady, styleVersion, fitBounds } = useMap();
  const {
    waypoints,
    mode,
    activeRouteIndex,
    setActiveRouteIndex,
    avoidHighways,
    avoidTolls,
    avoidFerries,
    units,
  } = useDirectionsStore();

  const routeWaypoints = useMemo(
    () =>
      waypoints.reduce<LngLat[]>((acc, wp) => {
        if (wp.coords) acc.push(wp.coords);
        return acc;
      }, []),
    [waypoints],
  );
  const allFilled = routeWaypoints.length === waypoints.length && waypoints.length >= 2;

  const { data } = useDirections({
    // Transit uses the transit-plan endpoint and flights deep-link out — neither
    // routes through the ground engines, so skip the directions query for both.
    waypoints: mode === "transit" || mode === "flying" ? [] : allFilled ? routeWaypoints : [],
    mode,
    avoidHighways,
    avoidTolls,
    avoidFerries,
    units,
  });

  // Add map source and layers
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const setup = () => {
      if (map.getSource(SOURCE_ID)) return;

      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.addLayer({
        id: LAYER_ALT_CASING,
        type: "line",
        source: SOURCE_ID,
        filter: ["==", ["get", "type"], "alt"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.6 },
      });

      map.addLayer({
        id: LAYER_ALT_LINE,
        type: "line",
        source: SOURCE_ID,
        filter: ["==", ["get", "type"], "alt"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#93C5FD", "line-width": 5, "line-opacity": 0.75 },
      });

      map.addLayer({
        id: LAYER_ACTIVE_CASING,
        type: "line",
        source: SOURCE_ID,
        filter: ["==", ["get", "type"], "active"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#ffffff", "line-width": 10 },
      });

      map.addLayer({
        id: LAYER_ACTIVE_LINE,
        type: "line",
        source: SOURCE_ID,
        filter: ["==", ["get", "type"], "active"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": PRIMARY_BLUE_HEX, "line-width": 7 },
      });

      map.on("click", LAYER_ALT_LINE, onClick);
    };

    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      const features = e.features;
      if (features?.[0]) {
        const idx = features[0].properties?.routeIndex as number | undefined;
        if (idx !== undefined) setActiveRouteIndex(idx);
      }
    };
    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      if (!map.getLayer(LAYER_ALT_LINE)) return;
      const features = map.queryRenderedFeatures(e.point, { layers: [LAYER_ALT_LINE] });
      if (features.length > 0) {
        map.getCanvasContainer().style.cursor = "pointer";
      } else {
        map.getCanvasContainer().style.cursor = "";
      }
    };

    if (map.isStyleLoaded()) {
      setup();
    } else {
      map.once("load", setup);
    }
    map.on("mousemove", onMouseMove);
    return () => {
      map.off("load", setup);
      map.off("click", LAYER_ALT_LINE, onClick);
      map.off("mousemove", onMouseMove);
      map.getCanvasContainer().style.cursor = "";
    };
  }, [mapRef, mapReady, styleVersion, setActiveRouteIndex]);

  // Update source data whenever routes change
  useEffect(() => {
    const map = mapRef.current;
    const raw = map?.getSource(SOURCE_ID);
    if (!raw || raw.type !== "geojson") return;
    const source = raw as GeoJSONSource;

    if (mode === "transit" || mode === "flying") {
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

    features.sort((a) => (a.properties.type === "active" ? 1 : -1));

    (source as GeoJSONSource).setData({ type: "FeatureCollection", features });

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

  // Clear routes when all waypoints are empty (panel closed)
  useEffect(() => {
    const hasAnyCoords = waypoints.some((wp) => wp.coords !== null);
    if (!hasAnyCoords) {
      const map = mapRef.current;
      const raw = map?.getSource(SOURCE_ID);
      if (raw && raw.type === "geojson") {
        (raw as GeoJSONSource).setData({ type: "FeatureCollection", features: [] });
      }
    }
  }, [waypoints, mapRef]);

  return null;
}
