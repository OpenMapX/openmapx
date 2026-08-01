"use client";

import {
  fetchRoadConditions,
  projectEventsToRoute,
  type RoadConditionEvent,
  useNavigationStore,
} from "@openmapx/core";
import type { GeoJSONSource } from "maplibre-gl";
import { useEffect, useMemo, useState } from "react";
import { addLayerInSlot, unregisterLayerSlot } from "@/components/map/layers/layerStack";
import { useOverlayLayerVisible } from "@/components/map/overlay/useOverlayStoreState";
import { useMap } from "@/lib/MapContext";
import { useOverlayMinZoom } from "@/lib/overlayZoomGate";
import { useDrawnDirectionsRoutes } from "@/lib/useDrawnDirectionsRoutes";
import { markerImageId, markerPoints } from "./markers";

const OVERLAY_ID = "road-conditions";
const MARKER_SOURCE = "omx-road-conditions-route-markers";
const LINE_SOURCE = "omx-road-conditions-route-lines";
const MARKER_LAYER = "omx-road-conditions-route-markers";
const LINE_LAYER = "omx-road-conditions-route-line";

// Same coarse cadence the nav incident fetch uses (useNavIncidents.ts).
const REFRESH_MS = 120_000;
const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};

const EMPTY = { type: "FeatureCollection" as const, features: [] };
// Stable reference (not a fresh `[]` literal) so a repeat "nothing to show"
// call is a no-op for React's setState identity check — `useDrawnDirectionsRoutes`
// keeps its own empty fallback stable for the same reason (see its module
// comment); without this, a caller whose route/geometry reference is not
// perfectly memoized re-triggers this effect every render, and each run would
// otherwise hand React a brand-new empty array, forcing another render forever.
const EMPTY_EVENTS: RoadConditionEvent[] = [];

/** Bounding box around a whole route, padded enough to catch its shoulder. */
function routeBounds(geometry: [number, number][]): [number, number, number, number] | null {
  if (geometry.length < 2) return null;
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const [lng, lat] of geometry) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  const pad = 0.01;
  return [west - pad, south - pad, east + pad, north + pad];
}

/**
 * Conditions on the route, drawn in the zoom band the area overlay leaves
 * empty. The overlay is gated at its manifest `minZoom` so a country-sized
 * viewport can't pull thousands of incidents — but that is exactly the zoom
 * where a whole planned route is on screen, which left a closure on the route
 * invisible while planning. `maxzoom` here is that same gate, so the two layers
 * never draw together and nothing has to be deduplicated.
 */
export function RouteConditionsLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const minZoom = useOverlayMinZoom(OVERLAY_ID);
  const layerVisible = useOverlayLayerVisible(OVERLAY_ID);
  const drawn = useDrawnDirectionsRoutes();
  const navRoute = useNavigationStore((s) => s.route);
  const navigating = useNavigationStore((s) => s.status) !== "idle";

  const geometry = useMemo(() => {
    if (navigating) return navRoute?.geometry ?? [];
    return drawn.routes[drawn.activeRouteIndex]?.geometry ?? [];
  }, [navigating, navRoute, drawn.routes, drawn.activeRouteIndex]);

  const [events, setEvents] = useState<RoadConditionEvent[]>(EMPTY_EVENTS);

  useEffect(() => {
    if (!layerVisible || geometry.length < 2) {
      setEvents(EMPTY_EVENTS);
      return;
    }
    const box = routeBounds(geometry as [number, number][]);
    const map = mapRef.current;
    if (!box || !map || !mapReady) return;

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const load = () => {
      void fetchRoadConditions(box).then((found) => {
        if (!cancelled) setEvents(found);
      });
    };
    const stopPolling = () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    // This layer only ever draws below the overlay's min zoom (`maxzoom`
    // mirrors that same threshold), so polling at or above it would repeat a
    // country-scale query for a layer painting nothing — the area overlay is
    // already running its own, viewport-scoped fetch for the same events up
    // there. Pausing rather than clearing `events` keeps the last known
    // result ready the instant the user zooms back below the threshold,
    // with a fresh fetch firing immediately then.
    const syncPolling = () => {
      if (map.getZoom() < minZoom) {
        if (timer === undefined) {
          load();
          timer = setInterval(load, REFRESH_MS);
        }
      } else {
        stopPolling();
      }
    };

    syncPolling();
    map.on("zoomend", syncPolling);
    return () => {
      cancelled = true;
      stopPolling();
      map.off("zoomend", syncPolling);
    };
  }, [layerVisible, geometry, mapRef, mapReady, minZoom]);

  const onRoute = useMemo(() => {
    if (geometry.length < 2 || events.length === 0) return [];
    // The whole route, not just the stretch ahead: while planning there is no
    // "ahead" yet, and while driving the overview still shows the full trip.
    // `useNavIncidents` establishes the same "whole route" precedent for its
    // own overview consumers.
    const lookaheadMeters = Number.POSITIVE_INFINITY;
    return projectEventsToRoute(events, geometry, 0, { lookaheadMeters });
  }, [events, geometry]);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const sync = () => {
      if (!layerVisible) {
        try {
          if (map.getLayer(MARKER_LAYER)) map.removeLayer(MARKER_LAYER);
          if (map.getLayer(LINE_LAYER)) map.removeLayer(LINE_LAYER);
          if (map.getSource(MARKER_SOURCE)) map.removeSource(MARKER_SOURCE);
          if (map.getSource(LINE_SOURCE)) map.removeSource(LINE_SOURCE);
        } catch {
          // Style already torn down.
        }
        unregisterLayerSlot(MARKER_LAYER);
        unregisterLayerSlot(LINE_LAYER);
        return;
      }
      if (!map.isStyleLoaded()) {
        map.once("idle", sync);
        return;
      }
      if (!map.getSource(LINE_SOURCE)) map.addSource(LINE_SOURCE, { type: "geojson", data: EMPTY });
      if (!map.getSource(MARKER_SOURCE)) {
        map.addSource(MARKER_SOURCE, { type: "geojson", data: EMPTY });
      }
      if (!map.getLayer(LINE_LAYER)) {
        addLayerInSlot(
          map,
          {
            id: LINE_LAYER,
            type: "line",
            source: LINE_SOURCE,
            maxzoom: minZoom,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": [
                "match",
                ["get", "severity"],
                "critical",
                "#7e0023",
                "high",
                "#cc0033",
                "medium",
                "#ff9933",
                "low",
                "#ffde33",
                "#8a8a8a",
              ],
              "line-width": ["interpolate", ["linear"], ["zoom"], 5, 3, 10, 6],
              "line-opacity": 0.85,
            },
          },
          "conditions-lines",
          1,
        );
      }
      if (!map.getLayer(MARKER_LAYER)) {
        addLayerInSlot(
          map,
          {
            id: MARKER_LAYER,
            type: "symbol",
            source: MARKER_SOURCE,
            maxzoom: minZoom,
            layout: {
              "icon-image": ["get", "_icon"],
              "icon-size": ["interpolate", ["linear"], ["zoom"], 5, 0.42, 10, 0.55],
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
              "symbol-sort-key": ["get", "_sev"],
            },
          },
          "overlay-markers",
          1,
        );
      }
    };

    sync();
    map.on("styledata", sync);
    return () => {
      map.off("styledata", sync);
    };
  }, [mapRef, mapReady, styleVersion, layerVisible, minZoom]);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map) return;
    const markerSource = map.getSource(MARKER_SOURCE) as GeoJSONSource | undefined;
    const lineSource = map.getSource(LINE_SOURCE) as GeoJSONSource | undefined;
    if (!markerSource || !lineSource) return;

    markerSource.setData({
      type: "FeatureCollection",
      features: onRoute.flatMap((alert) => {
        // One marker per real MultiPoint endpoint, not a centroid — matches
        // the area overlay's own placement (`markerPoints` in ./markers) so
        // the two components never disagree about where an event sits.
        const points = markerPoints(alert.geometry);
        const targets = points.length > 0 ? points : [alert.coord];
        return targets.map((point) => ({
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: point },
          properties: {
            headline: alert.headline,
            severity: alert.severity,
            _icon: markerImageId(alert.eventType, alert.severity),
            _sev: SEVERITY_RANK[alert.severity] ?? 0,
          },
        }));
      }),
    });

    lineSource.setData({
      type: "FeatureCollection",
      features: onRoute
        .filter(
          (alert) =>
            alert.geometry.type === "LineString" || alert.geometry.type === "MultiLineString",
        )
        .map((alert) => ({
          type: "Feature" as const,
          geometry: alert.geometry as GeoJSON.Geometry,
          properties: { severity: alert.severity },
        })),
    });
  }, [mapRef, styleVersion, onRoute]);

  return null;
}

export default RouteConditionsLayer;
