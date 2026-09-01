"use client";

import { useNavigationStore } from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useMemo } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import type { MapLayerGroup, SlottedLayer } from "@/integration-api/map/mapLayerGroup";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useMapAttributions } from "@/integration-api/overlay/useMapAttributions";
import { attributionsForProviders } from "@/lib/attributionForProviders";
import { ROUTE_COLORS, ROUTE_WIDTHS } from "@/lib/routeStyle";
import { buildNavRouteLine, navRouteProgressFraction } from "./navRouteSplit";
import type { DynamicLineState } from "./useMapDynamicLineState";
import { useMapDynamicLineState } from "./useMapDynamicLineState";

const SOURCE = "nav-route-source";
const TRAVELED = "nav-route-traveled";
export const NAV_ROUTE_REMAINING_LAYER_ID = "nav-route-remaining";
export const NAV_ROUTE_REMAINING_WIDTH = ROUTE_WIDTHS.nav.line;
const REMAINING_CASING = "nav-route-remaining-casing";

const ALT_SOURCE = "nav-route-alts-source";
const ALT = "nav-route-alts";
const PROPOSED = "nav-route-proposed";
const EMPTY_FC = { type: "FeatureCollection" as const, features: [] };
const TRANSPARENT = "rgba(0,0,0,0)";

export function NavigationRouteLayer() {
  const { mapRef } = useMap();
  const status = useNavigationStore((s) => s.status);
  const route = useNavigationStore((s) => s.route);
  const routes = useNavigationStore((s) => s.routes);
  const activeRouteIndex = useNavigationStore((s) => s.activeRouteIndex);
  const fasterRoute = useNavigationStore((s) => s.fasterRoute);
  const progress = useNavigationStore((s) => s.progress);
  const routeProvider = useNavigationStore((s) => s.routeProvider);

  // Credit the routing engine on the map's attribution control while navigating,
  // so the credit shows during turn-by-turn (the directions panel is gone).
  const registry = useIntegrationRegistry();
  const navRouteAttributions = useMemo(
    () => (status === "idle" ? [] : attributionsForProviders(registry, [routeProvider])),
    [registry, routeProvider, status],
  );
  useMapAttributions("nav-route", navRouteAttributions);

  // Cache the turf line + total length per route so the per-fix update below
  // doesn't re-walk the whole geometry every time the user moves.
  const navLine = useMemo(() => (route ? buildNavRouteLine(route.geometry) : null), [route]);

  // One feature for the whole route, published once per route — never per
  // fix. The traveled/remaining boundary is now purely a paint concern (see
  // `dynamicState` below), so this memo must not depend on `progress`:
  // depending on it would put the `setData` upload straight back on the hot
  // path this rewrite exists to take it off of.
  const activeFeatures = useMemo(() => {
    if (status === "idle" || !route || route.geometry.length < 2) return EMPTY_FC;
    return {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          properties: {},
          geometry: { type: "LineString" as const, coordinates: route.geometry },
        },
      ],
    };
  }, [status, route]);

  // Where along the line (as a `line-progress` fraction, not a naive
  // geodesic ratio — see navRouteSplit.ts) the traveled/remaining boundary
  // sits. This is the only thing that changes per GPS fix.
  const progressFraction = useMemo(
    () => (navLine ? navRouteProgressFraction(navLine, progress?.alongMeters ?? 0) : 0),
    [navLine, progress?.alongMeters],
  );

  // `step`, not `interpolate`: MapLibre's line renderer only sizes the
  // gradient texture from the line's actual on-screen length and samples it
  // with `gl.NEAREST` when the expression is a step interpolant
  // (`stepInterpolant` in `line_style_layer.ts`). An `interpolate` gradient
  // always uses a flat 256px texture with linear filtering, which would
  // quantize and blur the traveled/remaining boundary into a visible ramp
  // instead of the hard edge the driver sees today.
  const dynamicState = useMemo<DynamicLineState>(
    () => ({
      paint: {
        [TRAVELED]: {
          "line-gradient": [
            "step",
            ["line-progress"],
            ROUTE_COLORS.traveled,
            progressFraction,
            TRANSPARENT,
          ],
        },
        [NAV_ROUTE_REMAINING_LAYER_ID]: {
          "line-gradient": [
            "step",
            ["line-progress"],
            TRANSPARENT,
            progressFraction,
            ROUTE_COLORS.active,
          ],
        },
        [REMAINING_CASING]: {
          "line-gradient": [
            "step",
            ["line-progress"],
            TRANSPARENT,
            progressFraction,
            ROUTE_COLORS.casing,
          ],
        },
      },
    }),
    [progressFraction],
  );

  const altFeatures = useMemo(() => {
    if (status === "idle") return EMPTY_FC;
    const alts = routes
      .map((r, i) => ({ r, i }))
      .filter(({ r, i }) => i !== activeRouteIndex && r.geometry.length >= 2)
      .map(({ r, i }) => ({
        type: "Feature" as const,
        properties: { routeIndex: i, kind: "alt" },
        geometry: { type: "LineString" as const, coordinates: r.geometry },
      }));
    const proposed =
      fasterRoute && fasterRoute.route.geometry.length >= 2
        ? [
            {
              type: "Feature" as const,
              properties: { kind: "proposed" },
              geometry: { type: "LineString" as const, coordinates: fasterRoute.route.geometry },
            },
          ]
        : [];
    return { type: "FeatureCollection" as const, features: [...alts, ...proposed] };
  }, [status, routes, activeRouteIndex, fasterRoute]);

  // Each layer's slot, not its creation order, puts the alternates beneath the
  // active route. The order values deliberately sit above the ones `RouteLayer`
  // uses in the same two slots: equal values would tie, and a tie is resolved by
  // whichever registered first — the very race the slot registry exists to remove.
  const group = useMemo<MapLayerGroup>(
    () => ({
      sources: {
        [ALT_SOURCE]: { type: "geojson", data: altFeatures },
        // `lineMetrics` is what makes `["line-progress"]` available to the
        // gradients in `dynamicState` above.
        [SOURCE]: { type: "geojson", lineMetrics: true, data: activeFeatures },
      },
      layers: [
        {
          id: ALT,
          type: "line",
          source: ALT_SOURCE,
          filter: ["!=", ["get", "kind"], "proposed"],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ROUTE_COLORS.navAlt,
            "line-width": ROUTE_WIDTHS.nav.altLine,
            "line-opacity": 0.55,
          },
          slot: "route-alt",
          order: 2,
        },
        {
          id: PROPOSED,
          type: "line",
          source: ALT_SOURCE,
          filter: ["==", ["get", "kind"], "proposed"],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ROUTE_COLORS.proposed,
            "line-width": ROUTE_WIDTHS.nav.altLine,
            "line-dasharray": [2, 1],
          },
          slot: "route-alt",
          order: 4,
        },
        {
          // No `kind` filter: the source now holds one feature covering the
          // whole route. Which portion this casing actually shows is a
          // `line-gradient` paint concern, applied dynamically below — see
          // `dynamicState`.
          id: REMAINING_CASING,
          type: "line",
          source: SOURCE,
          layout: { "line-cap": "round", "line-join": "round" },
          // `line-color` is the fallback shown for the one tick before the
          // gradient in `dynamicState` lands.
          paint: { "line-color": ROUTE_COLORS.casing, "line-width": ROUTE_WIDTHS.nav.casing },
          slot: "route-active",
          order: 2,
        },
        {
          id: TRAVELED,
          type: "line",
          source: SOURCE,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ROUTE_COLORS.traveled,
            "line-width": ROUTE_WIDTHS.nav.traveled,
            "line-opacity": 0.7,
          },
          slot: "route-active",
          order: 3,
        },
        {
          id: NAV_ROUTE_REMAINING_LAYER_ID,
          type: "line",
          source: SOURCE,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": ROUTE_COLORS.active, "line-width": NAV_ROUTE_REMAINING_WIDTH },
          slot: "route-active",
          order: 4,
        },
      ] satisfies SlottedLayer[],
    }),
    [activeFeatures, altFeatures],
  );
  useMapLayerGroup(group);
  // Must run after `useMapLayerGroup` so its effect fires after the layers
  // it targets exist.
  useMapDynamicLineState(dynamicState);

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
