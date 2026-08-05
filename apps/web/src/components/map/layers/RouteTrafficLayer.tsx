"use client";

import { type RouteFlowInput, useNavigationStore, useRouteFlow } from "@openmapx/core";
import { useMemo } from "react";
import { ROUTE_ALT_OPACITY, ROUTE_WIDTHS } from "@/lib/routeStyle";
import { flowColorExpression } from "@/lib/trafficFlowExpression";
import { useDrawnDirectionsRoutes } from "@/lib/useDrawnDirectionsRoutes";
import { useIntegrationDomainAttribution } from "@/lib/useIntegrationAttribution";
import type { MapLayerGroup, SlottedLayer } from "./mapLayerGroup";
import {
  activeSpanFilter,
  type BandRoute,
  buildCurrentSpanFeatures,
  buildStaticSpanFeatures,
} from "./routeFlowBands";
import type { DynamicLineState } from "./useMapDynamicLineState";
import { useMapDynamicLineState } from "./useMapDynamicLineState";
import { useMapLayerGroup } from "./useMapLayerGroup";

const SOURCE = "route-traffic-source";
const CURRENT_SOURCE = "route-traffic-current-source";
const ACTIVE_LAYER = "route-traffic-active";
const CURRENT_LAYER = "route-traffic-current";
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

  // Only ever set while actually navigating: in planning mode no progress
  // applies at all, and the active route is drawn exactly like an alternate
  // (fully in the static source, nothing "current").
  const currentAlongMeters = navigating ? alongMeters : 0;

  // While navigating the nav store owns the drawn route (traveled/remaining
  // split, live reroutes); otherwise the planning result does. Same bands, same
  // paint, different source of geometry.
  //
  // Deliberately excludes `alongMeters`/`currentAlongMeters`: this is what the
  // polled flow query keys off (via `flowInputs` below), and what the *static*
  // congestion source is built from. Letting progress into this dependency
  // list would re-hash every route's geometry, and re-publish the whole
  // congestion picture, on every GPS fix.
  const routes = useMemo<BandRoute[]>(() => {
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
      }));
  }, [enabled, navigating, navRoutes, navActiveIndex, drawn.routes, drawn.activeRouteIndex]);

  const flowInputs = useMemo<RouteFlowInput[]>(
    () => routes.map((route) => ({ id: route.id, geometry: route.geometry })),
    [routes],
  );
  const spansByRoute = useRouteFlow(flowInputs, enabled);

  const hasBands = Object.values(spansByRoute).some((spans) => spans.length > 0);
  useIntegrationDomainAttribution("road-conditions", enabled && hasBands);

  // The whole picture, untrimmed — never re-published on progress alone (see
  // `routes`'s own comment above).
  const staticFeatures = useMemo(
    () => (enabled ? buildStaticSpanFeatures(routes, spansByRoute) : EMPTY),
    [enabled, routes, spansByRoute],
  );

  const activeRoute = useMemo(() => routes.find((route) => route.variant === "active"), [routes]);

  // The handful of features (usually 0 or 1) the driver is inside right now.
  // This *is* meant to change every GPS fix — cheap because it is small, not
  // because it is memoized away.
  const currentFeatures = useMemo(() => {
    if (!enabled || !activeRoute || currentAlongMeters <= 0) return EMPTY;
    const spans = spansByRoute[activeRoute.id] ?? [];
    return {
      type: "FeatureCollection" as const,
      features: buildCurrentSpanFeatures(activeRoute, spans, currentAlongMeters),
    };
  }, [enabled, activeRoute, spansByRoute, currentAlongMeters]);

  const activeFilter = useMemo(() => activeSpanFilter(currentAlongMeters), [currentAlongMeters]);
  const dynamicState = useMemo<DynamicLineState>(
    () => ({ filters: { [ACTIVE_LAYER]: activeFilter } }),
    [activeFilter],
  );

  const group = useMemo<MapLayerGroup>(() => {
    const color = flowColorExpression("speedRatio", "los");
    // `route-traffic-active` and `route-traffic-current` share paint by
    // value, not by object reference: each layer gets its own literal so
    // nothing can mutate one and silently affect the other.
    const activeLineWidth = navigating ? ROUTE_WIDTHS.nav.line : ROUTE_WIDTHS.planning.line;
    return {
      sources: {
        [SOURCE]: { type: "geojson", data: staticFeatures },
        [CURRENT_SOURCE]: { type: "geojson", data: currentFeatures },
      },
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
          // Base filter only; `activeSpanFilter(currentAlongMeters)` is
          // applied dynamically below so a progress tick never re-creates
          // this layer.
          id: ACTIVE_LAYER,
          type: "line",
          source: SOURCE,
          filter: ["==", ["get", "variant"], "active"],
          layout: { "line-join": "round", "line-cap": "butt" },
          paint: { "line-color": color, "line-width": activeLineWidth },
          slot: "route-congestion",
          order: 1,
        },
        {
          // No filter needed: this source only ever holds the current span(s).
          // Same paint as `route-traffic-active` — it is the same road, just
          // drawn from a source that only carries the one span the driver is
          // presently inside.
          id: CURRENT_LAYER,
          type: "line",
          source: CURRENT_SOURCE,
          layout: { "line-join": "round", "line-cap": "butt" },
          paint: { "line-color": color, "line-width": activeLineWidth },
          slot: "route-congestion",
          order: 2,
        },
      ] satisfies SlottedLayer[],
    };
  }, [staticFeatures, currentFeatures, navigating]);
  useMapLayerGroup(group);
  // Must run after `useMapLayerGroup` so its effect fires after the layer exists.
  useMapDynamicLineState(dynamicState);

  return null;
}
