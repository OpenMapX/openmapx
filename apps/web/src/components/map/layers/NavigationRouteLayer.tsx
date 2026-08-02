"use client";

import { useNavigationStore } from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type maplibregl from "maplibre-gl";
import { useEffect, useMemo } from "react";
import { attributionsForProviders } from "@/lib/attributionForProviders";
import { useMap } from "@/lib/MapContext";
import { ROUTE_COLORS, ROUTE_WIDTHS } from "@/lib/routeStyle";
import { useMapAttributions } from "@/lib/useMapAttributions";
import type { MapLayerGroup, SlottedLayer } from "./mapLayerGroup";
import { buildNavRouteLine, splitNavRoute } from "./navRouteSplit";
import { useMapLayerGroup } from "./useMapLayerGroup";

const SOURCE = "nav-route-source";
const TRAVELED = "nav-route-traveled";
export const NAV_ROUTE_REMAINING_LAYER_ID = "nav-route-remaining";
export const NAV_ROUTE_REMAINING_WIDTH = ROUTE_WIDTHS.nav.line;
const REMAINING_CASING = "nav-route-remaining-casing";

const ALT_SOURCE = "nav-route-alts-source";
const ALT = "nav-route-alts";
const PROPOSED = "nav-route-proposed";
const EMPTY_FC = { type: "FeatureCollection" as const, features: [] };

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

  const activeFeatures = useMemo(() => {
    if (status === "idle" || !route || route.geometry.length < 2) return EMPTY_FC;
    return {
      type: "FeatureCollection" as const,
      features: splitNavRoute(route.geometry, progress?.alongMeters ?? 0, navLine ?? undefined),
    };
  }, [status, route, navLine, progress?.alongMeters]);

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
        [SOURCE]: { type: "geojson", data: activeFeatures },
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
          id: REMAINING_CASING,
          type: "line",
          source: SOURCE,
          filter: ["==", ["get", "kind"], "remaining"],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": ROUTE_COLORS.casing, "line-width": ROUTE_WIDTHS.nav.casing },
          slot: "route-active",
          order: 2,
        },
        {
          id: TRAVELED,
          type: "line",
          source: SOURCE,
          filter: ["==", ["get", "kind"], "traveled"],
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
          filter: ["==", ["get", "kind"], "remaining"],
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
