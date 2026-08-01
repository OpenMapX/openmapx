"use client";

import { type RouteFlowInput, useNavigationStore, useRouteFlow } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useEffect, useMemo } from "react";
import { useMap } from "@/lib/MapContext";
import { ROUTE_ALT_OPACITY, ROUTE_WIDTHS } from "@/lib/routeStyle";
import { flowColorExpression } from "@/lib/trafficFlowExpression";
import { useDrawnDirectionsRoutes } from "@/lib/useDrawnDirectionsRoutes";
import { useIntegrationDomainAttribution } from "@/lib/useIntegrationAttribution";
import { addLayerInSlot } from "./layerStack";
import { type BandRoute, buildBandFeatures } from "./routeFlowBands";

type GeoJSONSource = maplibregl.GeoJSONSource;

const SOURCE = "route-traffic-source";
const ACTIVE_LAYER = "route-traffic-active";
const ALT_LAYER = "route-traffic-alt";

/** Congestion is a driving concern; a bike route through a jam is not slowed by it. */
const MOTORISED = new Set(["driving", "motorcycle"]);

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/**
 * Live congestion painted on the route itself: the band is a slice of the drawn
 * line at the line's own width, so the casing still frames it and a coloured
 * stretch reads as part of the route rather than a road crossing it. Only
 * worse-than-free-flow stretches are painted — plain blue means clear ahead.
 *
 * Drawn whenever a motorised route is on the map, independent of the
 * traffic-flow overlay toggle: that toggle governs other roads, and turning it
 * off must not hide a jam on the road the user is about to drive.
 */
export function RouteTrafficLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const drawn = useDrawnDirectionsRoutes();
  const navStatus = useNavigationStore((s) => s.status);
  const navRoutes = useNavigationStore((s) => s.routes);
  const navActiveIndex = useNavigationStore((s) => s.activeRouteIndex);
  const navMode = useNavigationStore((s) => s.mode);
  const alongMeters = useNavigationStore((s) => s.progress?.alongMeters ?? 0);

  const navigating = navStatus !== "idle";
  const mode = navigating ? navMode : drawn.mode;
  const enabled = MOTORISED.has(mode);

  // While navigating the nav store owns the drawn route (traveled/remaining
  // split, live reroutes); otherwise the planning result does. Same bands, same
  // paint, different source of geometry.
  const bandRoutes = useMemo<BandRoute[]>(() => {
    if (!enabled) return [];
    const source = navigating
      ? navRoutes.map((route, i) => ({ geometry: route.geometry, active: i === navActiveIndex }))
      : drawn.routes.map((route, i) => ({
          geometry: route.geometry,
          active: i === drawn.activeRouteIndex,
        }));
    return source
      .filter((entry) => entry.geometry.length >= 2)
      .map((entry, i) => ({
        id: `r${i}`,
        geometry: entry.geometry,
        variant: entry.active ? ("active" as const) : ("alt" as const),
        ...(navigating && entry.active ? { alongMeters } : {}),
      }));
  }, [
    enabled,
    navigating,
    navRoutes,
    navActiveIndex,
    drawn.routes,
    drawn.activeRouteIndex,
    alongMeters,
  ]);

  // The polled query keys off geometry, so it must not see the per-fix
  // `alongMeters` — clipping to what is left of the drive happens at render.
  const flowInputs = useMemo<RouteFlowInput[]>(
    () => bandRoutes.map((route) => ({ id: route.id, geometry: route.geometry })),
    [bandRoutes],
  );
  const spansByRoute = useRouteFlow(flowInputs, enabled);

  const hasBands = Object.values(spansByRoute).some((spans) => spans.length > 0);
  useIntegrationDomainAttribution("road-conditions", enabled && hasBands);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const setup = () => {
      if (!map.isStyleLoaded()) {
        map.once("idle", setup);
        return;
      }
      if (map.getSource(SOURCE)) return;
      map.addSource(SOURCE, { type: "geojson", data: EMPTY });

      // Bake the width current at creation time rather than starting at a
      // placeholder and correcting afterward: `setup` can run synchronously or
      // (mid style-load) be deferred to the next `idle`, and a hardcoded
      // fallback here would paint a near-invisible hairline until something
      // else happens to touch `navigating`/`styleVersion` again. The
      // width-sync effect below still owns the live planning<->navigation
      // transition on an already-created layer.
      const color = flowColorExpression("speedRatio", "los");
      const activeWidth = navigating ? ROUTE_WIDTHS.nav.line : ROUTE_WIDTHS.planning.line;
      const altWidth = navigating ? ROUTE_WIDTHS.nav.altLine : ROUTE_WIDTHS.planning.altLine;
      addLayerInSlot(
        map,
        {
          id: ALT_LAYER,
          type: "line",
          source: SOURCE,
          filter: ["==", ["get", "variant"], "alt"],
          // Square ends: a rounded cap would bleed the jam's colour past where
          // the jam actually is.
          layout: { "line-join": "round", "line-cap": "butt" },
          paint: { "line-color": color, "line-opacity": ROUTE_ALT_OPACITY, "line-width": altWidth },
        },
        "route-alt",
        2,
      );
      addLayerInSlot(
        map,
        {
          id: ACTIVE_LAYER,
          type: "line",
          source: SOURCE,
          filter: ["==", ["get", "variant"], "active"],
          layout: { "line-join": "round", "line-cap": "butt" },
          paint: { "line-color": color, "line-width": activeWidth },
        },
        "route-congestion",
        1,
      );
    };

    setup();
    map.on("styledata", setup);
    return () => {
      map.off("styledata", setup);
    };
    // `navigating` is read only to bake the width a fresh layer is created
    // with; re-running this effect when it changes is harmless (the
    // `map.getSource(SOURCE)` guard makes it a no-op once the layers exist)
    // and keeps that initial value honest instead of silencing the read.
  }, [mapRef, mapReady, styleVersion, navigating]);

  // Band width tracks the line it sits on, which differs between the planning
  // and navigation route styles. Layer creation above already bakes in the
  // width current at that moment; this effect only has to fire when
  // `navigating` flips on an already-created layer (starting/stopping
  // turn-by-turn without a style change in between). `styleVersion` stays in
  // the deps so a swap that happens to land while `navigating` is being
  // re-evaluated doesn't leave a stale width behind either.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map?.getLayer(ACTIVE_LAYER) || !map.getLayer(ALT_LAYER)) return;
    map.setPaintProperty(
      ACTIVE_LAYER,
      "line-width",
      navigating ? ROUTE_WIDTHS.nav.line : ROUTE_WIDTHS.planning.line,
    );
    map.setPaintProperty(
      ALT_LAYER,
      "line-width",
      navigating ? ROUTE_WIDTHS.nav.altLine : ROUTE_WIDTHS.planning.altLine,
    );
  }, [mapRef, navigating, styleVersion]);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    const raw = map?.getSource(SOURCE);
    if (raw?.type !== "geojson") return;
    (raw as GeoJSONSource).setData(enabled ? buildBandFeatures(bandRoutes, spansByRoute) : EMPTY);
  }, [mapRef, styleVersion, enabled, bandRoutes, spansByRoute]);

  return null;
}
