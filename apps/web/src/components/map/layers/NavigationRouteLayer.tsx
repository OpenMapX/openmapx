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

const ALT_SOURCE = "nav-route-alts-source";
const ALT = "nav-route-alts";

const REMAINING_COLOR = "#1a73e8";
const TRAVELED_COLOR = "#9aa0a6";
const ALT_COLOR = "#80868b";

export function NavigationRouteLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const status = useNavigationStore((s) => s.status);
  const route = useNavigationStore((s) => s.route);
  const routes = useNavigationStore((s) => s.routes);
  const activeRouteIndex = useNavigationStore((s) => s.activeRouteIndex);
  const progress = useNavigationStore((s) => s.progress);

  // Cache the turf line + total length per route so the per-fix update below
  // doesn't re-walk the whole geometry every time the user moves.
  const navLine = useMemo(() => (route ? buildNavRouteLine(route.geometry) : null), [route]);

  // Create sources + layers once per style. The alternates layer is added first
  // so it sits beneath the active route.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (map.getSource(SOURCE)) return;

    map.addSource(ALT_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: ALT,
      type: "line",
      source: ALT_SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ALT_COLOR, "line-width": 6, "line-opacity": 0.55 },
    });

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

  // Update the active route's split geometry as the user moves.
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

  // Draw the (dimmed) alternative routes, each tagged with its index so a tap
  // can switch to it.
  useEffect(() => {
    const map = mapRef.current;
    const raw = map?.getSource(ALT_SOURCE);
    if (!raw || raw.type !== "geojson") return;
    const source = raw as GeoJSONSource;

    const features =
      status === "idle"
        ? []
        : routes
            .map((r, i) => ({ r, i }))
            .filter(({ r, i }) => i !== activeRouteIndex && r.geometry.length >= 2)
            .map(({ r, i }) => ({
              type: "Feature" as const,
              properties: { routeIndex: i },
              geometry: { type: "LineString" as const, coordinates: r.geometry },
            }));
    source.setData({ type: "FeatureCollection", features });
  }, [mapRef, status, routes, activeRouteIndex]);

  // Tap an alternative to switch to it; show a pointer cursor over one.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      const idx = e.features?.[0]?.properties?.routeIndex;
      if (typeof idx === "number") useNavigationStore.getState().selectRoute(idx);
    };
    const onEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = "";
    };
    map.on("click", ALT, onClick);
    map.on("mouseenter", ALT, onEnter);
    map.on("mouseleave", ALT, onLeave);
    return () => {
      map.off("click", ALT, onClick);
      map.off("mouseenter", ALT, onEnter);
      map.off("mouseleave", ALT, onLeave);
    };
  }, [mapRef]);

  return null;
}
