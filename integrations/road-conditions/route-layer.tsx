"use client";

import {
  fetchRoadConditionsWithStatus,
  projectEventsToRoute,
  type RoadConditionEvent,
  useNavigationStore,
} from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GeoJsonSourceData } from "@/integration-api/map/layerStyleUtils";
import { useMap } from "@/integration-api/map/MapContext";
import { registerMapOverlayInteraction } from "@/integration-api/map/mapInteractionArbiter";
import { useDrawnDirectionsRoutes } from "@/integration-api/map/useDrawnDirectionsRoutes";
import { useGeoJsonSourceDataBridge } from "@/integration-api/map/useGeoJsonSourceDataBridge";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useOverlayMinZoom } from "@/integration-api/overlay/overlayZoomGate";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";
import { roadConditionAttributions } from "./attributions";
import { loadRoadConditionBindings } from "./bindings";
import { buildRoadConditionDisplayGroups, buildRoadConditionFeatures } from "./display";
import {
  closeIncidentPopup,
  type IncidentLayerIds,
  incidentClickHits,
  incidentLayerGroup,
  openIncidentPopup,
} from "./incident-layers";
import { useIncidentsVisible } from "./incidents-visible";
import { buildRoadConditionPopupHtml, popupEvents, type RoadConditionPopupInput } from "./popup";
import { useRoadConditionsStore } from "./store";

const OVERLAY_ID = "road-conditions";
const ROUTE_LAYERS: IncidentLayerIds = {
  source: "omx-road-conditions-route",
  line: "omx-road-conditions-route-line",
  marker: "omx-road-conditions-route-markers",
};
const CREDIT_LAYERS = [ROUTE_LAYERS.marker, ROUTE_LAYERS.line];

// Same coarse cadence the nav incident fetch uses (useNavIncidents.ts).
const REFRESH_MS = 120_000;
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
  const layerVisible = useIncidentsVisible();
  useRenderedMapAttributions("road-conditions-route", CREDIT_LAYERS, layerVisible);
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
  const popupInputRef = useRef<RoadConditionPopupInput | null>(null);
  const viewNeedsRefreshRef = useRef(false);
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
  const locale = useLocale();
  const { apiUrl } = useEnv();

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
    const refreshOpenPopup = (needsRefresh: boolean) => {
      if (popupRef.current && popupInputRef.current) {
        popupRef.current.setHTML(
          buildRoadConditionPopupHtml({ ...popupInputRef.current, atMs: Date.now(), needsRefresh })
            .html,
        );
      }
    };

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
      viewNeedsRefreshRef.current = true;
      refreshOpenPopup(true);
      try {
        const result = await fetchRoadConditionsWithStatus(box, { signal: request.signal });
        if (cancelled || !request.isCurrent()) return;
        if (result.ok) {
          setEvents(result.events);
          hasRouteDataRef.current = true;
          viewNeedsRefreshRef.current = false;
          setRouteFetchStatus("ready");
        } else {
          viewNeedsRefreshRef.current = true;
          refreshOpenPopup(true);
          setRouteFetchStatus(hasRouteDataRef.current ? "stale" : "error");
        }
      } catch {
        if (!cancelled && request.isCurrent()) {
          viewNeedsRefreshRef.current = true;
          refreshOpenPopup(true);
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
          void load();
          timer = setInterval(() => void load(), REFRESH_MS);
        }
      } else {
        stopPolling();
        closeIncidentPopup(map, popupRef);
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

  useMapLayerGroup(
    useMemo(
      () =>
        layerVisible
          ? incidentLayerGroup(ROUTE_LAYERS, {
              zoom: { maxzoom: minZoom },
              order: 1,
              lineWidth: ["interpolate", ["linear"], ["zoom"], 5, 3, 10, 6],
              iconSize: ["interpolate", ["linear"], ["zoom"], 5, 0.42, 10, 0.55],
            })
          : null,
      [layerVisible, minZoom],
    ),
  );

  useEffect(() => {
    if (!layerVisible) return;
    const data: GeoJsonSourceData = {
      type: "FeatureCollection",
      features: buildRoadConditionFeatures(displayGroups, locale, Date.now(), (events) =>
        roadConditionAttributions(events),
      ),
    };
    publishGeoJson([{ sourceId: ROUTE_LAYERS.source, data }]);
  }, [displayGroups, layerVisible, locale, publishGeoJson]);

  // Route markers and route lines resolve through the same grouped popup as
  // the area overlay. This keeps a line click and a marker click equivalent,
  // including source-record disclosure for explicit provider groups.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    const unregister = registerMapOverlayInteraction(map, {
      id: "road-conditions-route",
      layerIds: [ROUTE_LAYERS.marker, ROUTE_LAYERS.line],
      priority: 100,
      onClick: (interaction) => {
        const hits = incidentClickHits(map, ROUTE_LAYERS.marker, interaction);
        if (hits.length === 0) return;

        const { lngLat } = interaction.event;
        const input: RoadConditionPopupInput = {
          atMs: Date.now(),
          needsRefresh: viewNeedsRefreshRef.current,
          hits,
          fallbackCoordinates: [lngLat.lng, lngLat.lat],
          eventsByDisplayId,
          formatDateTime: dtfRef.current.dateTime,
          formatDate: dtfRef.current.date,
          translate: (key, values) => tRef.current(key, values),
          locale,
        };
        popupInputRef.current = input;
        if (!openIncidentPopup(map, popupRef, input)) return;
        // The situation lists carry no bindings; read them for the cards shown.
        void loadRoadConditionBindings(apiUrl, popupEvents(input)).then((bindings) => {
          const popup = popupRef.current;
          if (popupInputRef.current !== input || !popup || bindings.size === 0) return;
          popupInputRef.current = { ...input, bindings };
          popup.setHTML(
            buildRoadConditionPopupHtml({
              ...popupInputRef.current,
              atMs: Date.now(),
              needsRefresh: viewNeedsRefreshRef.current,
            }).html,
          );
        });
      },
    });

    return () => {
      unregister();
      closeIncidentPopup(map, popupRef);
    };
  }, [mapRef, mapReady, styleVersion, layerVisible, eventsByDisplayId, locale, apiUrl]);

  return null;
}

export default RouteConditionsLayer;
