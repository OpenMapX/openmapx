"use client";

import type { LngLat } from "@openmapx/core";
import { useDataSources, useDirectionsStore } from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type maplibregl from "maplibre-gl";
import type { MapMouseEvent } from "maplibre-gl";
import { useEffect, useMemo } from "react";
import { attributionsForProviders } from "@/lib/attributionForProviders";
import { useMap } from "@/lib/MapContext";
import { EV_CHARGING_SOURCE_ID, openChargerPlace } from "@/lib/openChargerPlace";
import { ROUTE_ALT_OPACITY, ROUTE_COLORS, ROUTE_WIDTHS } from "@/lib/routeStyle";
import { useDrawnDirectionsRoutes } from "@/lib/useDrawnDirectionsRoutes";
import { useMapAttributions } from "@/lib/useMapAttributions";
import { addLayerInSlot } from "./layerStack";
import { upsertGeoJsonSource } from "./layerStyleUtils";

type GeoJSONSource = maplibregl.GeoJSONSource;

const SOURCE_ID = "route-source";
const LAYER_ALT_CASING = "route-alt-casing";
const LAYER_ALT_LINE = "route-alt-line";
const LAYER_ACTIVE_CASING = "route-active-casing";
const LAYER_ACTIVE_LINE = "route-active-line";

// EV charge-stop pins reuse the same circle-marker style DataSourceLayer uses
// for EV charging (green/amber availability, neutral default) — do not invent a
// new marker.
// Neutral grey rather than the brand colour: the brand is itself green, so an
// unknown-availability pin would otherwise read as "available".
const UNKNOWN_AVAILABILITY_COLOR = "#5F6368";
const EV_STOPS_SOURCE_ID = "ev-stops-source";
const EV_STOPS_LAYER_ID = "ev-stops-layer";

export function RouteLayer() {
  const { mapRef, mapReady, styleVersion, fitBounds } = useMap();
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

  // Add map source and layers
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const setup = () => {
      if (!map.isStyleLoaded()) {
        map.once("idle", setup);
        return;
      }
      if (map.getSource(SOURCE_ID)) return;

      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      addLayerInSlot(
        map,
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
        },
        "route-alt",
        0,
      );

      addLayerInSlot(
        map,
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
        },
        "route-alt",
        1,
      );

      addLayerInSlot(
        map,
        {
          id: LAYER_ACTIVE_CASING,
          type: "line",
          source: SOURCE_ID,
          filter: ["==", ["get", "type"], "active"],
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": ROUTE_COLORS.casing, "line-width": ROUTE_WIDTHS.planning.casing },
        },
        "route-active",
        0,
      );

      addLayerInSlot(
        map,
        {
          id: LAYER_ACTIVE_LINE,
          type: "line",
          source: SOURCE_ID,
          filter: ["==", ["get", "type"], "active"],
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": ROUTE_COLORS.active, "line-width": ROUTE_WIDTHS.planning.line },
        },
        "route-active",
        1,
      );

      map.on("click", LAYER_ALT_LINE, onClick);
    };

    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      const features = e.features;
      if (features?.[0]) {
        const idx = features[0].properties?.routeIndex as number | undefined;
        if (idx !== undefined) setActiveRouteIndex(idx);
      }
    };
    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      if (!map.getLayer(LAYER_ALT_LINE)) return;
      const features = map.queryRenderedFeatures(e.point, { layers: [LAYER_ALT_LINE] });
      if (features.length > 0) {
        map.getCanvasContainer().style.cursor = "pointer";
      } else {
        map.getCanvasContainer().style.cursor = "";
      }
    };

    // Re-add after a style/theme swap (which wipes all sources): `styledata`
    // re-fires on each style load and the in-setup `once("idle")` covers the
    // mid-load case, whereas `once("load")` fires only once — so the route would
    // vanish on a theme change.
    setup();
    map.on("styledata", setup);
    map.on("mousemove", onMouseMove);
    return () => {
      map.off("styledata", setup);
      map.off("click", LAYER_ALT_LINE, onClick);
      map.off("mousemove", onMouseMove);
      map.getCanvasContainer().style.cursor = "";
    };
  }, [mapRef, mapReady, styleVersion, setActiveRouteIndex]);

  // Update source data whenever routes change
  useEffect(() => {
    const map = mapRef.current;
    const raw = map?.getSource(SOURCE_ID);
    if (raw?.type !== "geojson") return;
    const source = raw as GeoJSONSource;

    if (navigating || mode === "transit" || mode === "flying") {
      source.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    if (routes.length === 0) {
      source.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const features = routes.map((route, i) => ({
      type: "Feature" as const,
      properties: {
        type: i === activeRouteIndex ? "active" : "alt",
        routeIndex: i,
      },
      geometry: {
        type: "LineString" as const,
        coordinates: route.geometry,
      },
    }));

    features.sort((a) => (a.properties.type === "active" ? 1 : -1));

    (source as GeoJSONSource).setData({ type: "FeatureCollection", features });

    const activeGeom = routes[activeRouteIndex]?.geometry;
    if (activeGeom && activeGeom.length >= 2) {
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
      // already lie on `activeGeom` — widen the box anyway in case a stop
      // sits just off the drawn line (rounding/matching slack).
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
    }
  }, [routes, activeRouteIndex, mode, isEvMode, evStops, mapRef, fitBounds, navigating]);

  // EV charge-stop pins: circle markers in the same style DataSourceLayer
  // uses for EV charging (green = available, amber = busy, grey = unknown).
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const stops = isEvMode ? evStops : [];

    const removeEvLayers = () => {
      try {
        if (map.getLayer(EV_STOPS_LAYER_ID)) map.removeLayer(EV_STOPS_LAYER_ID);
        if (map.getSource(EV_STOPS_SOURCE_ID)) map.removeSource(EV_STOPS_SOURCE_ID);
      } catch {
        // Style may already be torn down (theme swap)
      }
    };

    const sync = () => {
      if (!map.isStyleLoaded()) {
        map.once("idle", sync);
        return;
      }
      if (stops.length === 0) {
        removeEvLayers();
        return;
      }

      const geojson = {
        type: "FeatureCollection" as const,
        features: stops.map((stop) => ({
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
      };

      upsertGeoJsonSource(map, EV_STOPS_SOURCE_ID, geojson);

      if (!map.getLayer(EV_STOPS_LAYER_ID)) {
        addLayerInSlot(
          map,
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
          },
          "route-markers",
          0,
        );
      }
    };

    // Charge-stop pins open the same floating place card as a charger clicked
    // in the data-source layer.
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

    sync();
    map.on("styledata", sync);
    map.on("click", EV_STOPS_LAYER_ID, onStopClick);
    map.on("mouseenter", EV_STOPS_LAYER_ID, onStopEnter);
    map.on("mouseleave", EV_STOPS_LAYER_ID, onStopLeave);
    return () => {
      map.off("click", EV_STOPS_LAYER_ID, onStopClick);
      map.off("mouseenter", EV_STOPS_LAYER_ID, onStopEnter);
      map.off("mouseleave", EV_STOPS_LAYER_ID, onStopLeave);
      map.off("styledata", sync);
    };
  }, [isEvMode, evStops, mapReady, styleVersion, mapRef, evSourceMeta]);

  // Clear routes when all waypoints are empty (panel closed)
  useEffect(() => {
    const hasAnyCoords = waypoints.some((wp) => wp.coords !== null);
    if (!hasAnyCoords) {
      const map = mapRef.current;
      const raw = map?.getSource(SOURCE_ID);
      if (raw && raw.type === "geojson") {
        (raw as GeoJSONSource).setData({ type: "FeatureCollection", features: [] });
      }
    }
  }, [waypoints, mapRef]);

  return null;
}
