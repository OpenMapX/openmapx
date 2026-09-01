"use client";

import type { LngLat } from "@openmapx/core";
import { useDataSources, useDirectionsStore } from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type * as maplibregl from "maplibre-gl";
import type { MapMouseEvent } from "maplibre-gl";
import { useEffect, useMemo } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import type { MapLayerGroup, SlottedLayer } from "@/integration-api/map/mapLayerGroup";
import { useDrawnDirectionsRoutes } from "@/integration-api/map/useDrawnDirectionsRoutes";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useMapAttributions } from "@/integration-api/overlay/useMapAttributions";
import { attributionsForProviders } from "@/lib/attributionForProviders";
import { EV_CHARGING_SOURCE_ID, openChargerPlace } from "@/lib/openChargerPlace";
import { ROUTE_ALT_OPACITY, ROUTE_COLORS, ROUTE_WIDTHS } from "@/lib/routeStyle";

const SOURCE_ID = "route-source";
const LAYER_ALT_CASING = "route-alt-casing";
const LAYER_ALT_LINE = "route-alt-line";
const LAYER_ACTIVE_CASING = "route-active-casing";
const LAYER_ACTIVE_LINE = "route-active-line";

// EV charge-stop pins reuse the same circle-marker style DataSourceLayer uses
// for EV charging (green/amber availability, neutral default) — do not invent
// a new marker.
// Neutral grey rather than the brand colour: the brand is itself green, so an
// unknown-availability pin would otherwise read as "available".
const UNKNOWN_AVAILABILITY_COLOR = "#5F6368";
const EV_STOPS_SOURCE_ID = "ev-stops-source";
const EV_STOPS_LAYER_ID = "ev-stops-layer";
const EMPTY_FC = { type: "FeatureCollection" as const, features: [] };

export function RouteLayer() {
  const { mapRef, fitBounds } = useMap();
  const { waypoints, setActiveRouteIndex } = useDirectionsStore();
  const { routes, activeRouteIndex, provider, mode, isEvMode, evStops, navigating } =
    useDrawnDirectionsRoutes();
  // Charge-stop pins open the place card with the same category the data-source
  // layer applies, so the card looks identical however the charger was reached.
  const { data: dataSourcesData } = useDataSources();
  const evSourceMeta = useMemo(
    () => dataSourcesData?.sources?.find((s) => s.id === EV_CHARGING_SOURCE_ID) ?? null,
    [dataSourcesData],
  );

  // Credit the routing engine that served the drawn route, on the map's
  // attribution control — so the credit persists when the directions panel is
  // closed (the panel shows the same credit while open).
  const registry = useIntegrationRegistry();
  const routeAttributions = useMemo(
    () => (navigating ? [] : attributionsForProviders(registry, [provider])),
    [registry, provider, navigating],
  );
  useMapAttributions("route", routeAttributions);

  const hasWaypoints = waypoints.some((waypoint) => waypoint.coords !== null);
  const routeFeatures = useMemo(() => {
    if (
      !hasWaypoints ||
      navigating ||
      mode === "transit" ||
      mode === "flying" ||
      routes.length === 0
    ) {
      return EMPTY_FC;
    }
    const features = routes.map((route, i) => ({
      type: "Feature" as const,
      properties: { type: i === activeRouteIndex ? "active" : "alt", routeIndex: i },
      geometry: { type: "LineString" as const, coordinates: route.geometry },
    }));
    // The active route draws last so it sits over its alternates within the layer.
    features.sort((a) => (a.properties.type === "active" ? 1 : -1));
    return { type: "FeatureCollection" as const, features };
  }, [routes, activeRouteIndex, mode, navigating, hasWaypoints]);

  const routeGroup = useMemo<MapLayerGroup>(
    () => ({
      sources: { [SOURCE_ID]: { type: "geojson", data: routeFeatures } },
      layers: [
        {
          id: LAYER_ALT_CASING,
          type: "line",
          source: SOURCE_ID,
          filter: ["==", ["get", "type"], "alt"],
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": ROUTE_COLORS.casing,
            "line-width": ROUTE_WIDTHS.planning.altCasing,
            "line-opacity": 0.6,
          },
          slot: "route-alt",
          order: 0,
        },
        {
          id: LAYER_ALT_LINE,
          type: "line",
          source: SOURCE_ID,
          filter: ["==", ["get", "type"], "alt"],
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": ROUTE_COLORS.alt,
            "line-width": ROUTE_WIDTHS.planning.altLine,
            "line-opacity": ROUTE_ALT_OPACITY,
          },
          slot: "route-alt",
          order: 1,
        },
        {
          id: LAYER_ACTIVE_CASING,
          type: "line",
          source: SOURCE_ID,
          filter: ["==", ["get", "type"], "active"],
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": ROUTE_COLORS.casing, "line-width": ROUTE_WIDTHS.planning.casing },
          slot: "route-active",
          order: 0,
        },
        {
          id: LAYER_ACTIVE_LINE,
          type: "line",
          source: SOURCE_ID,
          filter: ["==", ["get", "type"], "active"],
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": ROUTE_COLORS.active, "line-width": ROUTE_WIDTHS.planning.line },
          slot: "route-active",
          order: 1,
        },
      ] satisfies SlottedLayer[],
    }),
    [routeFeatures],
  );
  useMapLayerGroup(routeGroup);

  // Delegated listeners live on the map, not the style, so they do not need a
  // style-change trigger.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      const idx = e.features?.[0]?.properties?.routeIndex as number | undefined;
      if (idx !== undefined) setActiveRouteIndex(idx);
    };
    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      if (!map.getLayer(LAYER_ALT_LINE)) return;
      const hit = map.queryRenderedFeatures(e.point, { layers: [LAYER_ALT_LINE] });
      map.getCanvasContainer().style.cursor = hit.length > 0 ? "pointer" : "";
    };
    map.on("click", LAYER_ALT_LINE, onClick);
    map.on("mousemove", onMouseMove);
    return () => {
      map.off("click", LAYER_ALT_LINE, onClick);
      map.off("mousemove", onMouseMove);
      map.getCanvasContainer().style.cursor = "";
    };
  }, [mapRef, setActiveRouteIndex]);

  // Fit the camera to a newly drawn route. This is camera behaviour, so a style
  // change must not re-fit and yank the map away from the user's position.
  // biome-ignore lint/correctness/useExhaustiveDependencies: preserve the camera effect's existing dependency contract
  useEffect(() => {
    if (navigating || mode === "transit" || mode === "flying" || routes.length === 0) return;

    const activeGeom = routes[activeRouteIndex]?.geometry;
    if (!activeGeom || activeGeom.length < 2) return;

    let minLng = activeGeom[0][0];
    let maxLng = activeGeom[0][0];
    let minLat = activeGeom[0][1];
    let maxLat = activeGeom[0][1];
    for (const [lng, lat] of activeGeom) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    // EV charge-stop coordinates are inserted waypoints, so they should
    // already lie on `activeGeom` — widen the box anyway in case a stop sits
    // just off the drawn line (rounding/matching slack).
    if (isEvMode) {
      for (const stop of evStops) {
        const [lng, lat] = stop.station.coordinates;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
    fitBounds(
      [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
      80,
    );
  }, [routes, activeRouteIndex, mode, isEvMode, evStops, mapRef, fitBounds, navigating]);

  const evStopsData = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: evStops.map((stop) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: stop.station.coordinates },
        properties: {
          id: stop.station.id,
          name: stop.station.name,
          availState: !stop.availability
            ? "unknown"
            : stop.availability.available > 0
              ? "available"
              : "busy",
        },
      })),
    }),
    [evStops],
  );

  const evGroup = useMemo<MapLayerGroup | null>(() => {
    if (!isEvMode || evStops.length === 0) return null;
    return {
      sources: { [EV_STOPS_SOURCE_ID]: { type: "geojson", data: evStopsData } },
      layers: [
        {
          id: EV_STOPS_LAYER_ID,
          type: "circle",
          source: EV_STOPS_SOURCE_ID,
          paint: {
            "circle-radius": 7,
            "circle-color": [
              "match",
              ["get", "availState"],
              "available",
              "#2E7D32",
              "busy",
              "#F9A825",
              UNKNOWN_AVAILABILITY_COLOR,
            ],
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 1.5,
          },
          slot: "route-markers",
          order: 0,
        },
      ] satisfies SlottedLayer[],
    };
  }, [evStops.length, evStopsData, isEvMode]);
  useMapLayerGroup(evGroup);

  // Charge-stop pins open the same floating place card as a charger clicked in
  // the data-source layer.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const onStopClick = (e: MapMouseEvent) => {
      if (!map.getLayer(EV_STOPS_LAYER_ID)) return;
      const features = map.queryRenderedFeatures(e.point, { layers: [EV_STOPS_LAYER_ID] });
      if (!features.length) return;
      const props = features[0].properties as { id: string; name: string };
      const coordinates = (features[0].geometry as { coordinates: number[] }).coordinates as LngLat;
      openChargerPlace(
        { id: props.id, name: props.name, coordinates },
        {
          placeCategory: evSourceMeta?.placeCategory,
          placeCategoryRaw: evSourceMeta?.placeCategoryRaw,
        },
      );
    };
    const onStopEnter = () => {
      map.getCanvasContainer().style.cursor = "pointer";
    };
    const onStopLeave = () => {
      map.getCanvasContainer().style.cursor = "";
    };
    map.on("click", EV_STOPS_LAYER_ID, onStopClick);
    map.on("mouseenter", EV_STOPS_LAYER_ID, onStopEnter);
    map.on("mouseleave", EV_STOPS_LAYER_ID, onStopLeave);
    return () => {
      map.off("click", EV_STOPS_LAYER_ID, onStopClick);
      map.off("mouseenter", EV_STOPS_LAYER_ID, onStopEnter);
      map.off("mouseleave", EV_STOPS_LAYER_ID, onStopLeave);
    };
  }, [evSourceMeta, mapRef]);

  return null;
}
