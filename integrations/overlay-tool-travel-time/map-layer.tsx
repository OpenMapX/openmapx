"use client";

import {
  type LngLat,
  TRANSIT_WALK_PROFILE,
  type TransitIsochroneRequest,
  type TransitReachabilitySurfaceRequest,
  useIsochrone,
  useTransitIsochrone,
  useTransitReachability,
} from "@openmapx/core";
import {
  captureResultContributors,
  parseContributors,
  withFeatureContributors,
} from "@openmapx/mobility-core/contributors";
import type { MapMouseEvent } from "maplibre-gl";
import { useEffect, useMemo, useRef } from "react";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import { addLayerInSlot, removeSlottedLayers } from "@/integration-api/map/layerStack";
import { useMap } from "@/integration-api/map/MapContext";
import { claimMapClick } from "@/integration-api/map/mapClickOwnership";
import { EMPTY_FEATURE_COLLECTION, type MapLayerGroup } from "@/integration-api/map/mapLayerGroup";
import { subscribeStyleLoaded } from "@/integration-api/map/styleLoadedSync";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { resolveTravelTimeBackend, type TravelTimeMode, useTravelTimeStore } from "./store";
import { TransitFieldLayer } from "./transit-field-layer";

const SOURCE_ID = "travel-time-source";
const FILL_LAYER = "travel-time-fill";
const OUTLINE_LAYER = "travel-time-outline";
const REACH_SOURCE = "travel-time-reach-source";
const REACH_LAYER = "travel-time-reach";
const ORIGIN_SOURCE = "travel-time-origin-source";
const ORIGIN_LAYER = "travel-time-origin";
const ORIGIN_PULSE_LAYER = "travel-time-origin-pulse";
const TRANSIT_FIELD_LAYER = "travel-time-transit-field";

const LAYER_IDS = [FILL_LAYER, OUTLINE_LAYER, REACH_LAYER, ORIGIN_LAYER, ORIGIN_PULSE_LAYER];

const MODE_COLORS: Record<TravelTimeMode, string> = {
  driving: "#1A73E8",
  walking: "#34A853",
  cycling: "#F9AB00",
  transit: "#6F42C1",
};

/** Smallest selected band (ascending) a reach time falls into, or -1 if beyond all. */
function bandIndex(reachMinutes: number, sortedAsc: number[]): number {
  for (let i = 0; i < sortedAsc.length; i++) {
    if (reachMinutes <= sortedAsc[i]) return i;
  }
  return -1;
}

function computeOpacity(index: number, total: number): number {
  if (total <= 1) return 0.2;
  const maxOpacity = 0.25;
  const minOpacity = 0.08;
  const t = (total - 1 - index) / (total - 1);
  return minOpacity + t * (maxOpacity - minOpacity);
}

function travelTimeGroup(
  contours: GeoJSON.FeatureCollection,
  reach: GeoJSON.FeatureCollection,
  origin: GeoJSON.FeatureCollection,
): MapLayerGroup {
  // `route-markers`, not an overlay band: the isochrone is the user's
  // active in-progress query — origin + contours drawn above the base
  // labels, exactly like the route's own waypoint pins.
  return {
    sources: {
      [SOURCE_ID]: { type: "geojson", data: contours },
      [REACH_SOURCE]: { type: "geojson", data: reach },
      [ORIGIN_SOURCE]: { type: "geojson", data: origin },
    },
    layers: [
      {
        id: FILL_LAYER,
        type: "fill",
        source: SOURCE_ID,
        slot: "route-markers",
        order: 18,
        paint: {
          "fill-color": ["get", "color"],
          "fill-opacity": ["get", "opacity"],
        },
      },
      {
        id: OUTLINE_LAYER,
        type: "line",
        source: SOURCE_ID,
        slot: "route-markers",
        order: 19,
        paint: {
          "line-color": ["get", "color"],
          "line-width": 2,
          "line-opacity": 0.6,
        },
      },
      // Optional/fallback stop diagnostics, graduated by time band.
      {
        id: REACH_LAYER,
        type: "circle",
        source: REACH_SOURCE,
        slot: "route-markers",
        order: 20,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 3, 13, 5, 16, 7],
          "circle-color": ["get", "color"],
          "circle-opacity": ["get", "opacity"],
          "circle-stroke-color": "#FFFFFF",
          "circle-stroke-width": 0.5,
          "circle-stroke-opacity": ["get", "opacity"],
        },
      },
      // Pulsing ring
      {
        id: ORIGIN_PULSE_LAYER,
        type: "circle",
        source: ORIGIN_SOURCE,
        slot: "route-markers",
        order: 21,
        paint: {
          "circle-radius": 14,
          "circle-color": "transparent",
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-width": 2,
          "circle-stroke-opacity": 0.3,
        },
      },
      // Origin dot
      {
        id: ORIGIN_LAYER,
        type: "circle",
        source: ORIGIN_SOURCE,
        slot: "route-markers",
        order: 22,
        paint: {
          "circle-radius": 7,
          "circle-color": ["get", "color"],
          "circle-stroke-color": "#FFFFFF",
          "circle-stroke-width": 2,
        },
      },
    ],
  };
}

export function TravelTimeLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const currentMap = mapRef.current;
  const isActive = useTravelTimeStore((s) => s.isActive);
  const origin = useTravelTimeStore((s) => s.origin);
  const mode = useTravelTimeStore((s) => s.mode);
  const selectedMinutes = useTravelTimeStore((s) => s.selectedMinutes);
  const anchored = useTravelTimeStore((s) => s.anchored);
  const queryTime = useTravelTimeStore((s) => s.queryTime);
  const showTransitStops = useTravelTimeStore((s) => s.showTransitStops);
  const transitFieldUnsupported = useTravelTimeStore((s) => s.transitFieldUnsupported);
  const transitSurfaceKind = useTravelTimeStore((s) => s.transitSurfaceKind);
  const transitPolygonBbox = useTravelTimeStore((s) => s.transitPolygonBbox);

  const draggingRef = useRef(false);
  const transitFieldLayerRef = useRef<TransitFieldLayer | null>(null);

  const backend = resolveTravelTimeBackend(mode);
  const isTransit = backend.kind === "transit-reachability";

  const { data: isochroneData } = useIsochrone({
    origin,
    mode: backend.kind === "street-isochrone" ? backend.mode : "walking",
    contourMinutes: selectedMinutes,
    enabled: isActive && !isTransit,
  });

  const transitRequest = useMemo<TransitReachabilitySurfaceRequest | null>(() => {
    if (!origin || !queryTime || !isTransit || selectedMinutes.length === 0) return null;
    return {
      origin: { lng: origin[0], lat: origin[1] },
      queryTime,
      direction: "depart-at",
      // The server needs only the largest budget. Lower visual bands are
      // composited from the same remaining-time field without a refetch.
      thresholdsMinutes: [Math.max(...selectedMinutes)],
      walkProfileId: TRANSIT_WALK_PROFILE.id,
    };
  }, [isTransit, origin, queryTime, selectedMinutes]);
  const { data: transitSurface } = useTransitReachability(transitRequest, isActive && isTransit);

  const showPolygons = isTransit && transitSurfaceKind === "polygons";

  // Track the visible extent while polygons are selected so pressing Generate
  // can freeze an area. Only the live viewport moves here; the frozen bbox that
  // actually drives sampling changes solely on an explicit request.
  useEffect(() => {
    const map = currentMap;
    if (!map || !mapReady || !isActive || !showPolygons) return;
    const setViewport = useTravelTimeStore.getState().setTransitPolygonViewport;
    const publishBounds = () => {
      const bounds = map.getBounds();
      setViewport([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]);
    };
    publishBounds();
    map.on("moveend", publishBounds);
    return () => {
      map.off("moveend", publishBounds);
    };
  }, [isActive, mapReady, currentMap, showPolygons]);
  const isochroneRequest = useMemo<TransitIsochroneRequest | null>(() => {
    if (!origin || !queryTime || !showPolygons || !transitPolygonBbox) return null;
    if (selectedMinutes.length === 0) return null;
    return {
      origin: { lng: origin[0], lat: origin[1] },
      queryTime,
      direction: "depart-at",
      // Unlike the estimated field, every threshold is contoured server-side
      // from one sampled field, so all of them travel in the request.
      thresholdsMinutes: [...selectedMinutes].sort((a, b) => a - b),
      walkProfileId: TRANSIT_WALK_PROFILE.id,
      bbox: transitPolygonBbox,
    };
  }, [origin, queryTime, selectedMinutes, showPolygons, transitPolygonBbox]);
  const { data: transitIsochrone } = useTransitIsochrone(
    isochroneRequest,
    isActive && showPolygons,
  );
  useRenderedMapAttributions(
    "travel-time:polygons",
    [FILL_LAYER, OUTLINE_LAYER],
    isActive && (!isTransit || showPolygons),
  );
  useRenderedMapAttributions(
    "travel-time:stops",
    [REACH_LAYER],
    isActive && isTransit && (showTransitStops || transitFieldUnsupported !== null),
  );
  useRenderedMapAttributions("travel-time:estimated", [], isActive && isTransit && !showPolygons, {
    resolveCustomContributors: () => transitFieldLayerRef.current?.renderedContributors() ?? [],
  });

  // Register interactive layers
  useEffect(() => {
    if (!isActive) return;
    for (const id of LAYER_IDS) INTERACTIVE_LAYER_IDS.add(id);
    return () => {
      for (const id of LAYER_IDS) INTERACTIVE_LAYER_IDS.delete(id);
    };
  }, [isActive]);

  // Own WebGL resources for the lifetime of this style/active transit layer.
  // Data and threshold changes below update only the instance buffer.
  useEffect(() => {
    void styleVersion;
    const map = currentMap;
    if (!map || !mapReady || !isActive || !isTransit) return;
    const setUnsupported = useTravelTimeStore.getState().setTransitFieldUnsupported;
    setUnsupported(null);
    const layer = new TransitFieldLayer({
      id: TRANSIT_FIELD_LAYER,
      seeds: [],
      thresholdsMinutes: [],
      onUnsupported: setUnsupported,
    });
    transitFieldLayerRef.current = layer;
    // A custom layer is a live object, not a serialisable spec, so it stays
    // outside the layer group.
    const unsubscribeStyle = subscribeStyleLoaded(map, () => {
      if (!map.getLayer(TRANSIT_FIELD_LAYER)) {
        addLayerInSlot(map, layer, "route-markers", 17);
      }
    });
    return () => {
      unsubscribeStyle();
      if (transitFieldLayerRef.current === layer) transitFieldLayerRef.current = null;
      removeSlottedLayers(map, [TRANSIT_FIELD_LAYER]);
    };
  }, [isActive, isTransit, mapReady, currentMap, styleVersion]);

  // The surface is an estimated continuous field rendered from MOTIS
  // one-to-all seeds. The origin seed adds direct walking reach.
  useEffect(() => {
    void styleVersion;
    void currentMap;
    // Blank the estimated field while polygons are shown so the two never stack
    // and imply an agreement they do not have.
    const seeds =
      origin && !showPolygons
        ? [
            { lng: origin[0], lat: origin[1], arrivalSeconds: 0, contributors: [] },
            ...(transitSurface?.seeds ?? []),
          ]
        : [];
    transitFieldLayerRef.current?.setData(
      seeds,
      showPolygons ? [] : selectedMinutes,
      transitSurface?.contributors ?? [],
    );
  }, [currentMap, origin, selectedMinutes, showPolygons, styleVersion, transitSurface]);

  const contours = useMemo((): GeoJSON.FeatureCollection => {
    // Sampled transit polygons reuse the street-isochrone fill/outline layers:
    // the server already sets `color` and `opacity` per feature, so no paint or
    // slot change is needed and the two surface kinds cannot diverge visually.
    if (showPolygons) return transitIsochrone?.featureCollection ?? EMPTY_FEATURE_COLLECTION;
    if (isTransit || !isochroneData || isochroneData.contours.length === 0) {
      return EMPTY_FEATURE_COLLECTION;
    }

    const color = MODE_COLORS[isochroneData.mode];
    const total = isochroneData.contours.length;

    // Render outermost first (lowest z), innermost last (highest z)
    const features: GeoJSON.Feature[] = [...isochroneData.contours]
      .sort((a, b) => b.time - a.time)
      .map((contour, i) =>
        withFeatureContributors(
          {
            type: "Feature",
            geometry: contour.geometry,
            properties: {
              color,
              opacity: computeOpacity(i, total),
              time: contour.time,
            },
          },
          contour.contributors,
        ),
      );
    return { type: "FeatureCollection", features };
  }, [isTransit, isochroneData, showPolygons, transitIsochrone]);

  // Transit reachability dots (one-to-all). Each reachable stop is coloured by
  // the transit mode and faded by which selected time band it falls into
  // (nearest band most opaque). Empty whenever transit isn't selected.
  const reach = useMemo((): GeoJSON.FeatureCollection => {
    const dotsVisible = showTransitStops || transitFieldUnsupported !== null;
    if (!isTransit || !dotsVisible || !transitSurface?.seeds.length) {
      return EMPTY_FEATURE_COLLECTION;
    }

    const sortedAsc = [...selectedMinutes].sort((a, b) => a - b);
    const bands = sortedAsc.length;
    const color = MODE_COLORS.transit;

    const features: GeoJSON.Feature[] = [];
    for (const seed of transitSurface.seeds) {
      const r = seed.arrivalSeconds / 60;
      const band = bandIndex(r, sortedAsc);
      if (band === -1) continue; // beyond the largest selected budget
      // Nearest band (index 0) most opaque.
      const opacity = bands <= 1 ? 0.8 : 0.85 - (band / (bands - 1)) * 0.5;
      features.push(
        withFeatureContributors(
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [seed.lng, seed.lat] },
            properties: { color, opacity, reachMinutes: r, name: seed.stop?.name ?? "" },
          },
          captureResultContributors(
            { contributors: parseContributors((seed as { contributors?: unknown }).contributors) },
            transitSurface.contributors,
          ),
        ),
      );
    }
    return { type: "FeatureCollection", features };
  }, [isTransit, selectedMinutes, showTransitStops, transitFieldUnsupported, transitSurface]);

  const originMarker = useMemo(
    (): GeoJSON.FeatureCollection =>
      origin
        ? {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: { type: "Point", coordinates: origin },
                properties: { color: MODE_COLORS[mode] },
              },
            ],
          }
        : EMPTY_FEATURE_COLLECTION,
    [mode, origin],
  );

  useMapLayerGroup(
    useMemo(
      () => (isActive ? travelTimeGroup(contours, reach, originMarker) : null),
      [contours, isActive, originMarker, reach],
    ),
  );

  // Click handler to set origin — disabled in anchored mode (e.g. Explore), where
  // the origin is the searched place and a global click would hijack marker clicks.
  useEffect(() => {
    const map = currentMap;
    if (!map || !mapReady || !isActive || anchored) return;

    const onClick = (e: MapMouseEvent) => {
      if (!claimMapClick(e, "travel-time")) return;
      const lngLat: LngLat = [e.lngLat.lng, e.lngLat.lat];
      useTravelTimeStore.getState().setOrigin(lngLat);
    };

    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [currentMap, mapReady, isActive, anchored]);

  // Origin marker drag
  useEffect(() => {
    const map = currentMap;
    if (!map || !mapReady || !isActive) return;

    const onMouseDown = (e: MapMouseEvent) => {
      const features = map.queryRenderedFeatures(e.point, { layers: [ORIGIN_LAYER] });
      if (features.length === 0) return;

      draggingRef.current = true;
      map.getCanvas().style.cursor = "grabbing";
      map.dragPan.disable();
      e.preventDefault();
    };

    const onMouseMove = (e: MapMouseEvent) => {
      if (!draggingRef.current) {
        const features = map.queryRenderedFeatures(e.point, { layers: [ORIGIN_LAYER] });
        map.getCanvas().style.cursor =
          features.length > 0 ? "pointer" : isActive && !anchored ? "crosshair" : "";
        return;
      }
      const lngLat: LngLat = [e.lngLat.lng, e.lngLat.lat];
      useTravelTimeStore.getState().setOrigin(lngLat);
    };

    const onMouseUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      map.getCanvas().style.cursor = anchored ? "" : "crosshair";
      map.dragPan.enable();
    };

    map.on("mousedown", onMouseDown);
    map.on("mousemove", onMouseMove);
    map.on("mouseup", onMouseUp);

    return () => {
      map.off("mousedown", onMouseDown);
      map.off("mousemove", onMouseMove);
      map.off("mouseup", onMouseUp);
      if (draggingRef.current) {
        map.dragPan.enable();
        draggingRef.current = false;
      }
    };
  }, [currentMap, mapReady, isActive, anchored]);

  // Cursor management — crosshair only when click-to-place is available (not anchored).
  useEffect(() => {
    const map = currentMap;
    if (!map) return;

    if (isActive && !anchored) {
      map.getCanvas().style.cursor = "crosshair";
    } else {
      map.getCanvas().style.cursor = "";
    }

    return () => {
      map.getCanvas().style.cursor = "";
    };
  }, [currentMap, isActive, anchored]);

  // Keyboard: Escape to deactivate
  useEffect(() => {
    if (!isActive) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        return;

      if (e.key === "Escape") {
        e.preventDefault();
        useTravelTimeStore.getState().deactivate();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isActive]);

  return null;
}
