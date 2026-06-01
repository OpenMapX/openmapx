"use client";

import { greatCircleArc, useDirectionsStore, useFlightStore } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";
import { PRIMARY_BLUE_HEX } from "@/lib/theme";

type GeoJSONSource = maplibregl.GeoJSONSource;

const SOURCE_ID = "flight-arc-source";
const LAYER_LINE = "flight-arc-line";
const LAYER_POINTS = "flight-arc-points";
const LAYER_LABELS = "flight-arc-labels";

const EMPTY = { type: "FeatureCollection" as const, features: [] };

/**
 * Draws the great-circle flight line + airport endpoints when the directions
 * panel is in flight ("flying") mode. Reads the two resolved airports from
 * `useFlightStore` (populated by `FlightPanel`). Mirrors `RouteLayer`'s
 * source/layer lifecycle.
 */
export function FlightArcLayer() {
  const { mapRef, mapReady, styleVersion, fitBounds } = useMap();
  const mode = useDirectionsStore((s) => s.mode);
  const from = useFlightStore((s) => s.from);
  const to = useFlightStore((s) => s.to);

  // Add source + layers once the style is ready.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const setup = () => {
      if (!map.isStyleLoaded()) {
        map.once("idle", setup);
        return;
      }
      if (map.getSource(SOURCE_ID)) return;

      map.addSource(SOURCE_ID, { type: "geojson", data: EMPTY });

      map.addLayer({
        id: LAYER_LINE,
        type: "line",
        source: SOURCE_ID,
        filter: ["==", ["get", "kind"], "line"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": PRIMARY_BLUE_HEX,
          "line-width": 3,
          "line-dasharray": [2, 1.5],
        },
      });

      map.addLayer({
        id: LAYER_POINTS,
        type: "circle",
        source: SOURCE_ID,
        filter: ["==", ["get", "kind"], "point"],
        paint: {
          "circle-radius": 5,
          "circle-color": "#ffffff",
          "circle-stroke-color": PRIMARY_BLUE_HEX,
          "circle-stroke-width": 2.5,
        },
      });

      map.addLayer({
        id: LAYER_LABELS,
        type: "symbol",
        source: SOURCE_ID,
        filter: ["==", ["get", "kind"], "point"],
        layout: {
          "text-field": ["get", "label"],
          "text-size": 12,
          "text-offset": [0, -1.2],
          "text-anchor": "bottom",
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": PRIMARY_BLUE_HEX,
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      });
    };

    // Re-add after a style/theme swap (which wipes all sources): `styledata`
    // re-fires on each style load — and the in-setup `once("idle")` covers the
    // mid-load case — whereas `once("load")` fires only once, so the overlay
    // would silently vanish on a theme change.
    setup();
    map.on("styledata", setup);
    return () => {
      map.off("styledata", setup);
    };
  }, [mapRef, mapReady, styleVersion]);

  // Update geometry whenever the airports or mode change.
  useEffect(() => {
    const map = mapRef.current;
    const raw = map?.getSource(SOURCE_ID);
    if (!raw || raw.type !== "geojson") return;
    const source = raw as GeoJSONSource;

    if (mode !== "flying" || !from || !to) {
      source.setData(EMPTY);
      return;
    }

    const arc = greatCircleArc(from.coordinates, to.coordinates, 96);
    source.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { kind: "line" },
          geometry: { type: "LineString", coordinates: arc },
        },
        {
          type: "Feature",
          properties: { kind: "point", label: from.iata },
          geometry: { type: "Point", coordinates: from.coordinates },
        },
        {
          type: "Feature",
          properties: { kind: "point", label: to.iata },
          geometry: { type: "Point", coordinates: to.coordinates },
        },
      ],
    });

    let minLng = arc[0][0];
    let maxLng = arc[0][0];
    let minLat = arc[0][1];
    let maxLat = arc[0][1];
    for (const [lng, lat] of arc) {
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
  }, [mode, from, to, mapRef, fitBounds]);

  return null;
}
