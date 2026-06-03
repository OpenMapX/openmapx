"use client";

import { useNavigationStore } from "@openmapx/core";
import { lineString } from "@turf/helpers";
import lineSliceAlong from "@turf/line-slice-along";
import type maplibregl from "maplibre-gl";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";

type GeoJSONSource = maplibregl.GeoJSONSource;

const SOURCE = "nav-route-source";
const TRAVELED = "nav-route-traveled";
const REMAINING = "nav-route-remaining";
const REMAINING_CASING = "nav-route-remaining-casing";

const REMAINING_COLOR = "#1a73e8";
const TRAVELED_COLOR = "#9aa0a6";

export function NavigationRouteLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const status = useNavigationStore((s) => s.status);
  const route = useNavigationStore((s) => s.route);
  const progress = useNavigationStore((s) => s.progress);

  // Create source + layers once per style.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (map.getSource(SOURCE)) return;

    map.addSource(SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: REMAINING_CASING,
      type: "line",
      source: SOURCE,
      filter: ["==", ["get", "kind"], "remaining"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-width": 11 },
    });
    map.addLayer({
      id: TRAVELED,
      type: "line",
      source: SOURCE,
      filter: ["==", ["get", "kind"], "traveled"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": TRAVELED_COLOR, "line-width": 7, "line-opacity": 0.7 },
    });
    map.addLayer({
      id: REMAINING,
      type: "line",
      source: SOURCE,
      filter: ["==", ["get", "kind"], "remaining"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": REMAINING_COLOR, "line-width": 8 },
    });
  }, [mapRef, mapReady, styleVersion]);

  // Update split geometry as the user moves.
  useEffect(() => {
    const map = mapRef.current;
    const raw = map?.getSource(SOURCE);
    if (!raw || raw.type !== "geojson") return;
    const source = raw as GeoJSONSource;

    if (status === "idle" || !route || route.geometry.length < 2) {
      source.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const line = lineString(route.geometry);
    const totalKm = route.distance / 1000;
    const alongKm = progress ? Math.min(progress.alongMeters / 1000, totalKm) : 0;

    const features: GeoJSON.Feature[] = [];
    if (alongKm > 0.001) {
      features.push({
        type: "Feature",
        properties: { kind: "traveled" },
        geometry: lineSliceAlong(line, 0, alongKm, { units: "kilometers" }).geometry,
      });
    }
    features.push({
      type: "Feature",
      properties: { kind: "remaining" },
      geometry: lineSliceAlong(line, alongKm, totalKm, { units: "kilometers" }).geometry,
    });
    source.setData({ type: "FeatureCollection", features });
  }, [mapRef, status, route, progress]);

  return null;
}
