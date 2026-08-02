"use client";

import { type RouteFlowInput, useNavigationStore, useRouteFlow } from "@openmapx/core";
import { useMemo } from "react";
import { ROUTE_ALT_OPACITY, ROUTE_WIDTHS } from "@/lib/routeStyle";
import { flowColorExpression } from "@/lib/trafficFlowExpression";
import { useDrawnDirectionsRoutes } from "@/lib/useDrawnDirectionsRoutes";
import { useIntegrationDomainAttribution } from "@/lib/useIntegrationAttribution";
import type { MapLayerGroup, SlottedLayer } from "./mapLayerGroup";
import { type BandRoute, buildBandFeatures } from "./routeFlowBands";
import { useMapLayerGroup } from "./useMapLayerGroup";

const SOURCE = "route-traffic-source";
const ACTIVE_LAYER = "route-traffic-active";
const ALT_LAYER = "route-traffic-alt";

/** Congestion is a driving concern; a bike route through a jam is not slowed by it. */
const MOTORISED = new Set(["driving", "motorcycle"]);

const EMPTY = { type: "FeatureCollection" as const, features: [] };

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

  const bandFeatures = useMemo(
    () => (enabled ? buildBandFeatures(bandRoutes, spansByRoute) : EMPTY),
    [enabled, bandRoutes, spansByRoute],
  );

  const group = useMemo<MapLayerGroup>(() => {
    const color = flowColorExpression("speedRatio", "los");
    return {
      sources: { [SOURCE]: { type: "geojson", data: bandFeatures } },
      layers: [
        {
          id: ALT_LAYER,
          type: "line",
          source: SOURCE,
          filter: ["==", ["get", "variant"], "alt"],
          // Square ends: a rounded cap would bleed the jam's colour past where
          // the jam actually is.
          layout: { "line-join": "round", "line-cap": "butt" },
          paint: {
            "line-color": color,
            "line-opacity": ROUTE_ALT_OPACITY,
            "line-width": navigating ? ROUTE_WIDTHS.nav.altLine : ROUTE_WIDTHS.planning.altLine,
          },
          // Above every alternate line, planning's and navigation's alike: the
          // band paints the alternate's own congestion onto it.
          slot: "route-alt",
          order: 3,
        },
        {
          id: ACTIVE_LAYER,
          type: "line",
          source: SOURCE,
          filter: ["==", ["get", "variant"], "active"],
          layout: { "line-join": "round", "line-cap": "butt" },
          paint: {
            "line-color": color,
            "line-width": navigating ? ROUTE_WIDTHS.nav.line : ROUTE_WIDTHS.planning.line,
          },
          slot: "route-congestion",
          order: 1,
        },
      ] satisfies SlottedLayer[],
    };
  }, [bandFeatures, navigating]);
  useMapLayerGroup(group);

  return null;
}
