"use client";

import { useNavigationStore } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useMemo } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { getMapClickOwner } from "@/integration-api/map/mapClickOwnership";
import {
  EMPTY_FEATURE_COLLECTION,
  type MapLayerGroup,
  type SlottedLayer,
} from "@/integration-api/map/mapLayerGroup";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { ROUTE_COLORS, ROUTE_WIDTHS } from "@/lib/routeStyle";
import { buildNavRouteLine, navRouteProgressFraction } from "./navRouteSplit";
import {
  routeGeometryFeatures,
  routeSegmentLayerId,
  routeSegmentProgress,
} from "./routeGeometryFeatures";
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
const TRANSPARENT = "rgba(0,0,0,0)";

export function NavigationRouteLayer() {
  const { mapRef } = useMap();
  const status = useNavigationStore((s) => s.status);
  const route = useNavigationStore((s) => s.route);
  const routes = useNavigationStore((s) => s.routes);
  const activeRouteIndex = useNavigationStore((s) => s.activeRouteIndex);
  const fasterRoute = useNavigationStore((s) => s.fasterRoute);
  const progress = useNavigationStore((s) => s.progress);
  // Cache the turf line + total length per route so the per-fix update below
  // doesn't re-walk the whole geometry every time the user moves.
  const navLine = useMemo(() => (route ? buildNavRouteLine(route.geometry) : null), [route]);

  // Upload captured geometry once per route; progress changes only paint.
  const activeFeatures = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: status === "idle" || !route ? [] : routeGeometryFeatures(route, {}),
    }),
    [status, route],
  );
  const gradientGroups = useMemo(
    () =>
      activeFeatures.features.map((_, index) =>
        [TRAVELED, NAV_ROUTE_REMAINING_LAYER_ID, REMAINING_CASING].map((id) =>
          routeSegmentLayerId(id, index),
        ),
      ),
    [activeFeatures],
  );
  useRenderedMapAttributions(
    "nav-route",
    [...gradientGroups.flat(), ALT, PROPOSED],
    status !== "idle",
    {
      // Every group draws exactly one captured span. Its traveled/remaining
      // alpha union covers the span, including before/after its progress interval.
      complementaryGradientGroups: gradientGroups,
    },
  );

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
  const dynamicState = useMemo<DynamicLineState>(() => {
    const paint: NonNullable<DynamicLineState["paint"]> = {};
    activeFeatures.features.forEach((feature, index) => {
      const localProgress = routeSegmentProgress(
        feature.properties,
        navLine?.mercatorCumulative ?? [],
        navLine?.mercatorTotal ?? 0,
        progressFraction,
      );
      for (const [id, before, after] of [
        [TRAVELED, ROUTE_COLORS.traveled, TRANSPARENT],
        [NAV_ROUTE_REMAINING_LAYER_ID, TRANSPARENT, ROUTE_COLORS.active],
        [REMAINING_CASING, TRANSPARENT, ROUTE_COLORS.casing],
      ])
        paint[routeSegmentLayerId(id, index)] = {
          "line-gradient": ["step", ["line-progress"], before, localProgress, after],
        };
    });
    return { paint };
  }, [activeFeatures, navLine, progressFraction]);

  const altFeatures = useMemo(() => {
    if (status === "idle") return EMPTY_FEATURE_COLLECTION;
    const alts = routes.flatMap((r, i) =>
      i === activeRouteIndex ? [] : routeGeometryFeatures(r, { routeIndex: i, kind: "alt" }),
    );
    const proposed = fasterRoute
      ? routeGeometryFeatures(fasterRoute.route, { kind: "proposed" })
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
        ...activeFeatures.features.flatMap(
          (_, index) =>
            [
              {
                id: routeSegmentLayerId(REMAINING_CASING, index),
                type: "line",
                source: SOURCE,
                filter: ["==", ["get", "geometryPart"], index],
                layout: { "line-cap": "round", "line-join": "round" },
                // `line-color` is the fallback shown for the one tick before the
                // gradient in `dynamicState` lands.
                paint: { "line-color": ROUTE_COLORS.casing, "line-width": ROUTE_WIDTHS.nav.casing },
                slot: "route-active",
                order: 2,
              },
              {
                id: routeSegmentLayerId(TRAVELED, index),
                type: "line",
                source: SOURCE,
                filter: ["==", ["get", "geometryPart"], index],
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
                id: routeSegmentLayerId(NAV_ROUTE_REMAINING_LAYER_ID, index),
                type: "line",
                source: SOURCE,
                filter: ["==", ["get", "geometryPart"], index],
                layout: { "line-cap": "round", "line-join": "round" },
                paint: {
                  "line-color": ROUTE_COLORS.active,
                  "line-width": NAV_ROUTE_REMAINING_WIDTH,
                },
                slot: "route-active",
                order: 4,
              },
            ] satisfies SlottedLayer[],
        ),
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
      if (getMapClickOwner(e)) return;
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
