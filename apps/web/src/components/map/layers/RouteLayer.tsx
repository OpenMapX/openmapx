"use client";

import type { LngLat } from "@openmapx/core";
import {
  useDataSources,
  useDirections,
  useDirectionsStore,
  useEvDirections,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type maplibregl from "maplibre-gl";
import type { MapMouseEvent } from "maplibre-gl";
import { useLocale } from "next-intl";
import { useEffect, useMemo } from "react";
import { attributionsForProviders } from "@/lib/attributionForProviders";
import { buildEvDirectionsRequest } from "@/lib/buildEvDirectionsRequest";
import { useMap } from "@/lib/MapContext";
import { EV_CHARGING_SOURCE_ID, openChargerPlace } from "@/lib/openChargerPlace";
import { PRIMARY_BLUE_HEX } from "@/lib/theme";
import { useMapAttributions } from "@/lib/useMapAttributions";
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
  const locale = useLocale();
  const {
    waypoints,
    mode,
    isEvMode,
    evSocStartPct,
    evSocArrivalMinPct,
    evForceNonExclusive,
    activeRouteIndex,
    setActiveRouteIndex,
    avoidHighways,
    avoidTolls,
    avoidFerries,
  } = useDirectionsStore();
  const units = useSettingsStore((s) => s.units);
  const avoidIncidents = useSettingsStore((s) => s.avoidIncidents);
  const evVehicleId = useSettingsStore((s) => s.evVehicleId);
  const evCustomVehicle = useSettingsStore((s) => s.evCustomVehicle);
  const evSocTargetPct = useSettingsStore((s) => s.evSocTargetPct);
  const evPreferredNetworks = useSettingsStore((s) => s.evPreferredNetworks);
  const evAvoidedNetworks = useSettingsStore((s) => s.evAvoidedNetworks);
  const evExclusiveNetworks = useSettingsStore((s) => s.evExclusiveNetworks);
  const evPreferCheaper = useSettingsStore((s) => s.evPreferCheaper);
  const evHomePricePerKwh = useSettingsStore((s) => s.evHomePricePerKwh);
  const evHomeCurrency = useSettingsStore((s) => s.evHomeCurrency);
  // Once turn-by-turn navigation starts, NavigationRouteLayer owns the on-map
  // route (traveled/remaining split, live reroutes). Keep the directions preview
  // dark so a reroute doesn't leave the original planned line stranded on the
  // map — and so this layer's fitBounds never fights the navigation camera.
  const navigating = useNavigationStore((s) => s.status) !== "idle";

  const routeWaypoints = useMemo(
    () =>
      waypoints.reduce<LngLat[]>((acc, wp) => {
        if (wp.coords) acc.push(wp.coords);
        return acc;
      }, []),
    [waypoints],
  );
  const allFilled = routeWaypoints.length === waypoints.length && waypoints.length >= 2;

  const { data } = useDirections({
    // Transit uses the transit-plan endpoint and flights deep-link out — neither
    // routes through the ground engines, so skip the directions query for both.
    // EV mode routes through `useEvDirections` below instead. Skip it while
    // navigating too: the nav layer draws the live route.
    waypoints:
      navigating || isEvMode || mode === "transit" || mode === "flying"
        ? []
        : allFilled
          ? routeWaypoints
          : [],
    mode,
    avoidHighways,
    avoidTolls,
    avoidFerries,
    avoidClosures: avoidIncidents,
    units,
    lang: locale,
  });

  // Independent EV-plan query — built with the exact same request the plan
  // card (DirectionsPanelContent) sends, so this hits the same query-cache
  // entry instead of firing a second network request.
  const evRequest = useMemo(
    () =>
      buildEvDirectionsRequest({
        isEvMode,
        waypoints: routeWaypoints,
        allWaypointsFilled: allFilled,
        vehicleId: evVehicleId,
        customVehicle: evCustomVehicle,
        socStartPct: evSocStartPct,
        socArrivalMinPct: evSocArrivalMinPct,
        socTargetPct: evSocTargetPct,
        avoidHighways,
        avoidTolls,
        avoidFerries,
        avoidClosures: avoidIncidents,
        preferredNetworks: evPreferredNetworks,
        avoidedNetworks: evAvoidedNetworks,
        exclusiveNetworks: evExclusiveNetworks,
        forceNonExclusive: evForceNonExclusive,
        preferCheaper: evPreferCheaper,
        homePricePerKwh: evHomePricePerKwh,
        homeCurrency: evHomeCurrency,
        units,
        lang: locale,
      }),
    [
      isEvMode,
      routeWaypoints,
      allFilled,
      evVehicleId,
      evCustomVehicle,
      evSocStartPct,
      evSocArrivalMinPct,
      evSocTargetPct,
      avoidHighways,
      avoidTolls,
      avoidFerries,
      avoidIncidents,
      evPreferredNetworks,
      evAvoidedNetworks,
      evExclusiveNetworks,
      evForceNonExclusive,
      evPreferCheaper,
      evHomePricePerKwh,
      evHomeCurrency,
      units,
      locale,
    ],
  );
  const { data: evData } = useEvDirections(navigating ? null : evRequest);
  // Charge-stop pins open the place card with the same category the data-source
  // layer applies, so the card looks identical however the charger was reached.
  const { data: dataSourcesData } = useDataSources();
  const evSourceMeta = useMemo(
    () => dataSourcesData?.sources?.find((s) => s.id === EV_CHARGING_SOURCE_ID) ?? null,
    [dataSourcesData],
  );

  // The result actually drawn on the map: the EV plan (route + inserted
  // charge-stop legs) in EV mode, the plain route otherwise.
  const activeResult = isEvMode ? evData : data;

  // Credit the routing engine that served the drawn route, on the map's
  // attribution control — so the credit persists when the directions panel is
  // closed (the panel shows the same credit while open).
  const registry = useIntegrationRegistry();
  const routeAttributions = useMemo(
    () => (navigating ? [] : attributionsForProviders(registry, [activeResult?.provider])),
    [registry, activeResult?.provider, navigating],
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

      map.addLayer({
        id: LAYER_ALT_CASING,
        type: "line",
        source: SOURCE_ID,
        filter: ["==", ["get", "type"], "alt"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.6 },
      });

      map.addLayer({
        id: LAYER_ALT_LINE,
        type: "line",
        source: SOURCE_ID,
        filter: ["==", ["get", "type"], "alt"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#93C5FD", "line-width": 5, "line-opacity": 0.75 },
      });

      map.addLayer({
        id: LAYER_ACTIVE_CASING,
        type: "line",
        source: SOURCE_ID,
        filter: ["==", ["get", "type"], "active"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#ffffff", "line-width": 10 },
      });

      map.addLayer({
        id: LAYER_ACTIVE_LINE,
        type: "line",
        source: SOURCE_ID,
        filter: ["==", ["get", "type"], "active"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": PRIMARY_BLUE_HEX, "line-width": 7 },
      });

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

    if (!activeResult || activeResult.routes.length === 0) {
      source.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const features = activeResult.routes.map((route, i) => ({
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

    const activeGeom = activeResult.routes[activeRouteIndex]?.geometry;
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
      if (isEvMode && evData) {
        for (const stop of evData.stops) {
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
  }, [activeResult, activeRouteIndex, mode, isEvMode, evData, mapRef, fitBounds, navigating]);

  // EV charge-stop pins: circle markers in the same style DataSourceLayer
  // uses for EV charging (green = available, amber = busy, grey = unknown).
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const stops = isEvMode && evData ? evData.stops : [];

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
        map.addLayer({
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
        });
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
  }, [isEvMode, evData, mapReady, styleVersion, mapRef, evSourceMeta]);

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
