"use client";

import { useNavigationStore } from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type maplibregl from "maplibre-gl";
import { useEffect, useMemo } from "react";
import { attributionsForProviders } from "@/lib/attributionForProviders";
import { useMap } from "@/lib/MapContext";
import { ROUTE_COLORS, ROUTE_WIDTHS } from "@/lib/routeStyle";
import { useMapAttributions } from "@/lib/useMapAttributions";
import { addLayerInSlot } from "./layerStack";
import { buildNavRouteLine, splitNavRoute } from "./navRouteSplit";

type GeoJSONSource = maplibregl.GeoJSONSource;

const SOURCE = "nav-route-source";
const TRAVELED = "nav-route-traveled";
export const NAV_ROUTE_REMAINING_LAYER_ID = "nav-route-remaining";
export const NAV_ROUTE_REMAINING_WIDTH = ROUTE_WIDTHS.nav.line;
const REMAINING_CASING = "nav-route-remaining-casing";

const ALT_SOURCE = "nav-route-alts-source";
const ALT = "nav-route-alts";

export function NavigationRouteLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const status = useNavigationStore((s) => s.status);
  const route = useNavigationStore((s) => s.route);
  const routes = useNavigationStore((s) => s.routes);
  const activeRouteIndex = useNavigationStore((s) => s.activeRouteIndex);
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

  // Create sources + layers once per style. Each layer's slot (not creation
  // order) puts the alternates beneath the active route. The order values
  // deliberately sit above the ones `RouteLayer` uses in the same two slots:
  // equal values would tie, and a tie is resolved by whichever component
  // registered first — the very race the slot registry exists to remove.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (map.getSource(SOURCE)) return;

    map.addSource(ALT_SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    addLayerInSlot(
      map,
      {
        id: ALT,
        type: "line",
        source: ALT_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ROUTE_COLORS.navAlt,
          "line-width": ROUTE_WIDTHS.nav.altLine,
          "line-opacity": 0.55,
        },
      },
      "route-alt",
      2,
    );

    map.addSource(SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    addLayerInSlot(
      map,
      {
        id: REMAINING_CASING,
        type: "line",
        source: SOURCE,
        filter: ["==", ["get", "kind"], "remaining"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ROUTE_COLORS.casing, "line-width": ROUTE_WIDTHS.nav.casing },
      },
      "route-active",
      2,
    );
    addLayerInSlot(
      map,
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
      },
      "route-active",
      3,
    );
    addLayerInSlot(
      map,
      {
        id: NAV_ROUTE_REMAINING_LAYER_ID,
        type: "line",
        source: SOURCE,
        filter: ["==", ["get", "kind"], "remaining"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ROUTE_COLORS.active, "line-width": NAV_ROUTE_REMAINING_WIDTH },
      },
      "route-active",
      4,
    );
  }, [mapRef, mapReady, styleVersion]);

  // Update the active route's split geometry as the user moves.
  useEffect(() => {
    const map = mapRef.current;
    const raw = map?.getSource(SOURCE);
    if (raw?.type !== "geojson") return;
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
    if (raw?.type !== "geojson") return;
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
