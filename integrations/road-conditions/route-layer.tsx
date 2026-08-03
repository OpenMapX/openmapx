"use client";

import {
  fetchRoadConditionsWithStatus,
  projectEventsToRoute,
  type RoadConditionEvent,
  useNavigationStore,
} from "@openmapx/core";
import type { MapGeoJSONFeature } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { addLayerInSlot, unregisterLayerSlot } from "@/components/map/layers/layerStack";
import type { GeoJsonSourceData } from "@/components/map/layers/layerStyleUtils";
import { useGeoJsonSourceDataBridge } from "@/components/map/layers/useGeoJsonSourceDataBridge";
import {
  registerMapOverlayInteraction,
  removeMapOverlayPopup,
  replaceMapOverlayPopup,
} from "@/components/map/overlay/mapInteractionArbiter";
import { useOverlayLayerVisible } from "@/components/map/overlay/useOverlayStoreState";
import { useMap } from "@/lib/MapContext";
import { useOverlayMinZoom } from "@/lib/overlayZoomGate";
import { useDateTimeFormat } from "@/lib/useDateTimeFormat";
import { useDrawnDirectionsRoutes } from "@/lib/useDrawnDirectionsRoutes";
import { buildRoadConditionDisplayGroups, type RoadConditionDisplayGroup } from "./display";
import { markerImageId } from "./markers";
import { buildRoadConditionPopupHtml } from "./popup";
import { useRoadConditionsStore } from "./store";
import {
  isFutureRoadCondition,
  ROAD_CONDITION_LINE_DASHARRAY,
  ROAD_CONDITION_LINE_OPACITY,
  ROAD_CONDITION_MARKER_OPACITY,
} from "./visual-style";

const OVERLAY_ID = "road-conditions";
const SOURCE = "omx-road-conditions-route";
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

interface RouteSourceData {
  data: GeoJsonSourceData;
}

function buildRouteSourceData(displayGroups: RoadConditionDisplayGroup[]): RouteSourceData {
  const markers = displayGroups.flatMap((group) => {
    const event = group.events.reduce((best, candidate) => {
      const bestRank = SEVERITY_RANK[best.severity] ?? 0;
      const candidateRank = SEVERITY_RANK[candidate.severity] ?? 0;
      return candidateRank > bestRank ? candidate : best;
    });
    const future = group.events.every(isFutureRoadCondition);
    return group.markerCoordinates.map((point) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: point },
      properties: {
        headline: event.headline,
        severity: event.severity,
        _icon: markerImageId(event.type, event.severity),
        _id: group.events.length === 1 ? event.id : group.displayId,
        _displayId: group.displayId,
        _sev: SEVERITY_RANK[event.severity] ?? 0,
        future,
      },
    }));
  });
  const lines = displayGroups.flatMap((group) => {
    if (!group.lineGeometry) return [];
    const event = group.events.reduce((best, candidate) => {
      const bestRank = SEVERITY_RANK[best.severity] ?? 0;
      const candidateRank = SEVERITY_RANK[candidate.severity] ?? 0;
      return candidateRank > bestRank ? candidate : best;
    });
    return [
      {
        type: "Feature" as const,
        geometry: group.lineGeometry as GeoJSON.Geometry,
        properties: {
          severity: event.severity,
          future: group.events.every(isFutureRoadCondition),
          _displayId: group.displayId,
        },
      },
    ];
  });
  return {
    data: { type: "FeatureCollection", features: [...markers, ...lines] },
  };
}

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
  const hasRouteDataRef = useRef(false);
  const { publish: publishGeoJson, beginRequest } = useGeoJsonSourceDataBridge({
    mapRef,
    mapReady,
    styleVersion,
    visible: layerVisible,
  });
  const setRouteFetchStatus = useRoadConditionsStore((s) => s.setRouteFetchStatus);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const dtf = useDateTimeFormat();
  const dtfRef = useRef(dtf);
  useEffect(() => {
    dtfRef.current = dtf;
  }, [dtf]);
  const t = useTranslations("roadConditions");
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    if (!layerVisible || geometry.length < 2) {
      setEvents(EMPTY_EVENTS);
      hasRouteDataRef.current = false;
      setRouteFetchStatus("idle");
      return;
    }
    const box = routeBounds(geometry as [number, number][]);
    const map = mapRef.current;
    if (!box || !map || !mapReady) return;

    let cancelled = false;
    let inFlight = false;
    let activeRequest: ReturnType<typeof beginRequest> | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;

    // A changed route must not briefly display incidents projected on the old
    // geometry. Failed refreshes are different: they retain the last good
    // route result and surface a stale status.
    setEvents(EMPTY_EVENTS);
    hasRouteDataRef.current = false;
    setRouteFetchStatus("idle");

    const load = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      const request = beginRequest();
      activeRequest = request;
      setRouteFetchStatus("loading");
      try {
        const result = await fetchRoadConditionsWithStatus(box, { signal: request.signal });
        if (cancelled || !request.isCurrent()) return;
        if (result.ok) {
          setEvents(result.events);
          hasRouteDataRef.current = true;
          setRouteFetchStatus("ready");
        } else {
          setRouteFetchStatus(hasRouteDataRef.current ? "stale" : "error");
        }
      } catch {
        if (!cancelled && request.isCurrent()) {
          setRouteFetchStatus(hasRouteDataRef.current ? "stale" : "error");
        }
      } finally {
        inFlight = false;
      }
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
      activeRequest?.cancel();
      stopPolling();
      map.off("zoomend", syncPolling);
    };
  }, [beginRequest, layerVisible, geometry, mapRef, mapReady, minZoom, setRouteFetchStatus]);

  const onRoute = useMemo(() => {
    if (geometry.length < 2 || events.length === 0) return [];
    // The whole route, not just the stretch ahead: while planning there is no
    // "ahead" yet, and while driving the overview still shows the full trip.
    // `useNavIncidents` establishes the same "whole route" precedent for its
    // own overview consumers.
    const lookaheadMeters = Number.POSITIVE_INFINITY;
    return projectEventsToRoute(events, geometry, 0, { lookaheadMeters });
  }, [events, geometry]);

  const displayGroups = useMemo(() => {
    if (onRoute.length === 0) return [];
    const eventsById = new Map(events.map((event) => [event.id, event] as const));
    const projectedEvents = onRoute.flatMap((alert) => {
      const event = eventsById.get(alert.id);
      if (!event) return [];
      return [
        {
          ...event,
          // Keep the projected event's source geometry as the rendering input;
          // projection has already established that this record belongs on the
          // route, while the display helper decides whether related records
          // should share one line/marker presentation.
          geometry: alert.geometry,
          ...(alert.groupId && !event.groupId ? { groupId: alert.groupId } : {}),
        },
      ];
    });
    return buildRoadConditionDisplayGroups(projectedEvents);
  }, [events, onRoute]);

  const eventsByDisplayId = useMemo(
    () => new Map(displayGroups.map((group) => [group.displayId, group.events] as const)),
    [displayGroups],
  );

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    let idleRetryScheduled = false;
    const sync = () => {
      if (!layerVisible) {
        idleRetryScheduled = false;
        try {
          if (map.getLayer(MARKER_LAYER)) map.removeLayer(MARKER_LAYER);
          if (map.getLayer(LINE_LAYER)) map.removeLayer(LINE_LAYER);
          if (map.getSource(SOURCE)) map.removeSource(SOURCE);
        } catch {
          // Style already torn down.
        }
        unregisterLayerSlot(MARKER_LAYER);
        unregisterLayerSlot(LINE_LAYER);
        return;
      }
      if (!map.isStyleLoaded()) {
        if (idleRetryScheduled) map.off("idle", sync);
        idleRetryScheduled = true;
        map.once("idle", sync);
        return;
      }
      idleRetryScheduled = false;
      if (!map.getSource(SOURCE)) {
        map.addSource(SOURCE, { type: "geojson", data: EMPTY });
      }
      if (!map.getLayer(LINE_LAYER)) {
        addLayerInSlot(
          map,
          {
            id: LINE_LAYER,
            type: "line",
            source: SOURCE,
            filter: ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
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
              "line-opacity": ROAD_CONDITION_LINE_OPACITY,
              "line-dasharray": ROAD_CONDITION_LINE_DASHARRAY,
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
            source: SOURCE,
            filter: ["==", ["geometry-type"], "Point"],
            maxzoom: minZoom,
            layout: {
              "icon-image": ["get", "_icon"],
              "icon-size": ["interpolate", ["linear"], ["zoom"], 5, 0.42, 10, 0.55],
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
              "symbol-sort-key": ["get", "_sev"],
            },
            paint: {
              "icon-opacity": ROAD_CONDITION_MARKER_OPACITY,
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
      if (idleRetryScheduled) map.off("idle", sync);
    };
  }, [mapRef, mapReady, styleVersion, layerVisible, minZoom]);

  useEffect(() => {
    void styleVersion;
    if (!layerVisible) return;
    const sourceData = buildRouteSourceData(displayGroups);
    publishGeoJson([{ sourceId: SOURCE, data: sourceData.data }]);
  }, [displayGroups, layerVisible, publishGeoJson, styleVersion]);

  // Route markers and route lines resolve through the same grouped popup as
  // the area overlay. This keeps a line click and a marker click equivalent,
  // including source-record disclosure for explicit provider groups.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    const unregister = registerMapOverlayInteraction(map, {
      id: "road-conditions-route",
      layerIds: [MARKER_LAYER, LINE_LAYER],
      priority: 100,
      onClick: ({ event, features }) => {
        const markerFeatures = features.filter((feature) => feature.layer?.id === MARKER_LAYER);
        let hits: MapGeoJSONFeature[] = markerFeatures;
        if (markerFeatures.length > 0) {
          const r = 24;
          const box: [[number, number], [number, number]] = [
            [event.point.x - r, event.point.y - r],
            [event.point.x + r, event.point.y + r],
          ];
          const queried = map.getLayer(MARKER_LAYER)
            ? (map.queryRenderedFeatures(box, { layers: [MARKER_LAYER] }) as MapGeoJSONFeature[])
            : [];
          if (queried.length > 0) hits = queried;
        } else {
          hits = features;
        }
        if (hits.length === 0) return;

        const content = buildRoadConditionPopupHtml({
          hits,
          fallbackCoordinates: [event.lngLat.lng, event.lngLat.lat],
          eventsByDisplayId,
          formatDateTime: dtfRef.current.dateTime,
          formatDate: dtfRef.current.date,
          translate: (key, values) => tRef.current(key, values),
        });
        const popup = new maplibregl.Popup({
          closeButton: true,
          maxWidth: "300px",
          className: "omx-popup",
        })
          .setLngLat(content.coordinates)
          .setHTML(content.html);
        popupRef.current = popup;
        replaceMapOverlayPopup(map, popup);
      },
    });

    return () => {
      unregister();
      if (popupRef.current) {
        removeMapOverlayPopup(map, popupRef.current);
        popupRef.current = null;
      }
    };
  }, [mapRef, mapReady, styleVersion, layerVisible, eventsByDisplayId]);

  return null;
}

export default RouteConditionsLayer;
