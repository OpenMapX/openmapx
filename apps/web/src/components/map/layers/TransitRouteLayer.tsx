"use client";

import { routeColor, usePlaceStore, useRouteStops, useTransitRoute } from "@openmapx/core";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";
import { PRIMARY_BLUE_HEX } from "@/lib/theme";

const SOURCE_ID = "transit-route-detail-source";
const LINE_LAYER_ID = "transit-route-detail-line";
const STOPS_SOURCE_ID = "transit-route-detail-stops-source";
const STOPS_LAYER_ID = "transit-route-detail-stops";
const CURRENT_STOP_LAYER_ID = "transit-route-detail-current-stop";

export function TransitRouteLayer() {
  const { mapRef, mapReady, styleVersion, fitBounds } = useMap();
  const { selectedPlace, activeRouteId } = usePlaceStore();
  const { data: route } = useTransitRoute(activeRouteId);
  const { data: stops } = useRouteStops(activeRouteId);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const cleanup = () => {
      if (map.getLayer(CURRENT_STOP_LAYER_ID)) map.removeLayer(CURRENT_STOP_LAYER_ID);
      if (map.getLayer(STOPS_LAYER_ID)) map.removeLayer(STOPS_LAYER_ID);
      if (map.getLayer(LINE_LAYER_ID)) map.removeLayer(LINE_LAYER_ID);
      if (map.getSource(STOPS_SOURCE_ID)) map.removeSource(STOPS_SOURCE_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    };

    if (!activeRouteId || !stops?.length) {
      cleanup();
      return;
    }

    const lineColor = routeColor(route, PRIMARY_BLUE_HEX);

    // Use route geometry from the API (road-snapped) when available,
    // otherwise fall back to connecting stop coordinates with straight lines.
    const fallbackGeom: { type: "LineString"; coordinates: [number, number][] } = {
      type: "LineString",
      coordinates: stops.map((s): [number, number] => [s.lng, s.lat]),
    };
    const routeGeometry = route?.geometry ?? fallbackGeom;

    // Collect all coordinates for bounds fitting
    const lineCoords =
      routeGeometry.type === "MultiLineString"
        ? (routeGeometry.coordinates as [number, number][][]).flat()
        : (routeGeometry.coordinates as [number, number][]);

    cleanup();

    map.addSource(SOURCE_ID, {
      type: "geojson",
      data: {
        type: "Feature",
        properties: {},
        geometry:
          routeGeometry.type === "MultiLineString"
            ? {
                type: "MultiLineString" as const,
                coordinates: routeGeometry.coordinates as [number, number][][],
              }
            : {
                type: "LineString" as const,
                coordinates: routeGeometry.coordinates as [number, number][],
              },
      },
    });

    map.addLayer({
      id: LINE_LAYER_ID,
      type: "line",
      source: SOURCE_ID,
      paint: {
        "line-color": lineColor,
        "line-width": 4,
        "line-opacity": 0.8,
      },
      layout: { "line-cap": "round", "line-join": "round" },
    });

    const stopsGeoJson = {
      type: "FeatureCollection" as const,
      features: stops.map((s) => ({
        type: "Feature" as const,
        properties: { id: s.id, name: s.name, isCurrent: s.id === selectedPlace?.id },
        geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] },
      })),
    };

    map.addSource(STOPS_SOURCE_ID, { type: "geojson", data: stopsGeoJson });

    map.addLayer({
      id: STOPS_LAYER_ID,
      type: "circle",
      source: STOPS_SOURCE_ID,
      filter: ["!=", ["get", "isCurrent"], true],
      paint: {
        "circle-radius": 5,
        "circle-color": "#fff",
        "circle-stroke-width": 2.5,
        "circle-stroke-color": lineColor,
      },
    });

    map.addLayer({
      id: CURRENT_STOP_LAYER_ID,
      type: "circle",
      source: STOPS_SOURCE_ID,
      filter: ["==", ["get", "isCurrent"], true],
      paint: {
        "circle-radius": 8,
        "circle-color": lineColor,
        "circle-stroke-width": 3,
        "circle-stroke-color": "#fff",
      },
    });

    if (lineCoords.length >= 2) {
      const lngs = lineCoords.map((c) => c[0]);
      const lats = lineCoords.map((c) => c[1]);
      fitBounds(
        [
          [Math.min(...lngs), Math.min(...lats)],
          [Math.max(...lngs), Math.max(...lats)],
        ],
        60,
      );
    }

    return cleanup;
  }, [mapRef, mapReady, styleVersion, activeRouteId, route, stops, selectedPlace?.id, fitBounds]);

  return null;
}
