"use client";

import { useNavigationStore } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useEffect, useMemo } from "react";
import { useMap } from "@/lib/MapContext";
import { buildNavRouteLine, splitNavRoute } from "./navRouteSplit";

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

  // Cache the turf line + total length per route so the per-fix update below
  // doesn't re-walk the whole geometry every time the user moves.
  const navLine = useMemo(() => (route ? buildNavRouteLine(route.geometry) : null), [route]);

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

    const features = splitNavRoute(
      route.geometry,
      progress?.alongMeters ?? 0,
      navLine ?? undefined,
    );
    source.setData({ type: "FeatureCollection", features });
  }, [mapRef, status, route, navLine, progress?.alongMeters]);

  return null;
}
