"use client";

import {
  type RoadConditionEvent,
  roadConditionFeatureToEvent,
  useOverlayExclusion,
} from "@openmapx/core";
import type { GeoJSONSource, MapGeoJSONFeature } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef } from "react";
import { addLayerInSlot, unregisterLayerSlot } from "@/integration-api/map/layerStack";
import { useMap } from "@/integration-api/map/MapContext";
import {
  registerMapOverlayInteraction,
  removeMapOverlayPopup,
  replaceMapOverlayPopup,
} from "@/integration-api/map/mapInteractionArbiter";
import { useGeoJsonSourceDataBridge } from "@/integration-api/map/useGeoJsonSourceDataBridge";
import { useOverlayMinZoom } from "@/integration-api/overlay/overlayZoomGate";
import { useIntegrationDomainAttribution } from "@/integration-api/overlay/useIntegrationAttribution";
import { useOverlayLayerVisible } from "@/integration-api/overlay/useOverlayStoreState";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";
import { buildRoadConditionDisplayGroups, buildRoadConditionFeatures } from "./display";
import { markerImageData, parseMarkerImageId } from "./markers";
import { buildRoadConditionPopupHtml } from "./popup";
import { RouteConditionsLayer } from "./route-layer";
import { SEVERITY_LINE_COLOR } from "./severity";
// The named import also runs the module side-effect that registers the
// "road-conditions" overlay store (shared by the layer selector + legend).
import { horizonDaysParam, useRoadConditionsStore } from "./store";
import {
  createViewportFetchScheduler,
  type ViewportBox,
  type ViewportFetchScheduler,
} from "./viewport-scheduler";
import {
  ROAD_CONDITION_LINE_DASHARRAY,
  ROAD_CONDITION_LINE_OPACITY,
  ROAD_CONDITION_MARKER_OPACITY,
} from "./visual-style";

export { buildRoadConditionPopupGroups } from "./popup";

type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];

const OVERLAY_ID = "road-conditions";
/**
 * The manifest domain the feeds are published under, which happens to spell the
 * same as this overlay's id — they are separate identifiers, so don't collapse
 * them: renaming the overlay would otherwise silently drop the credits.
 */
const CREDIT_DOMAIN = "road-conditions";
const SOURCE = "omx-road-conditions";
const LINE_LAYER = "omx-road-conditions-line";
const MARKER_LAYER = "omx-road-conditions-markers";

/**
 * The server's own `/events` cache TTL (`index.ts` caches the aggregation for
 * 60s and sends `Cache-Control: max-age=60`) — refetching sooner than this
 * with no viewport change would only replay the same cached response, so 60s
 * is the shortest interval that can actually return newer data while parked.
 */
const VIEWPORT_FRESHNESS_DEADLINE_MS = 60_000;

/**
 * Slack added on every side of the last-fetched viewport, as a fraction of
 * its own width/height, before a pan/zoom is judged to have left it. Large
 * enough that a navigation camera-follow — which nudges the viewport by a
 * small fraction of itself per frame — coasts inside it for a while; small
 * enough that a deliberate pan (which typically moves by more than half a
 * screen) crosses it on the very next coalesced evaluation.
 */
const VIEWPORT_PADDING_FACTOR = 0.5;

function boundsToViewportBox(map: maplibregl.Map | null): ViewportBox {
  const bounds = map?.getBounds();
  if (!bounds) return { west: 0, south: 0, east: 0, north: 0 };
  return {
    west: bounds.getWest(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    north: bounds.getNorth(),
  };
}

export interface RawFeature {
  geometry?: RoadConditionEvent["geometry"] | null;
  properties?: Record<string, unknown> | null;
}

export interface RoadConditionDisplaySources {
  data: GeoJsonData;
  /** In-memory child records used to resolve a grouped marker's popup. */
  eventsByDisplayId: Map<string, RoadConditionEvent[]>;
}

/**
 * Build the marker + line source data from the raw /events FeatureCollection:
 * one marker per display group (or every real endpoint where a group has no
 * line), and one visual line feature per unique rendered component set. Exact
 * overlaps can represent multiple display groups; child event records stay in
 * an in-memory lookup for popup resolution, and full child payloads are never
 * placed in MapLibre feature properties. This layer fetches GeoJSON directly,
 * so it reads each feature through the same validating reader the core
 * client uses.
 */
export function buildSources(
  features: RawFeature[],
  locale = "en",
  atMs: number = Date.now(),
): RoadConditionDisplaySources {
  const events = features
    .map(roadConditionFeatureToEvent)
    .filter((event): event is RoadConditionEvent => event !== null);
  const groups = buildRoadConditionDisplayGroups(events);
  const eventsByDisplayId = new Map(
    groups.map((group) => [group.displayId, group.events] as const),
  );
  return {
    data: {
      type: "FeatureCollection",
      features: buildRoadConditionFeatures(groups, locale, atMs),
    } as GeoJsonData,
    eventsByDisplayId,
  };
}

export function RoadConditionsLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const { apiUrl } = useEnv();
  // Declared in this integration's manifest, the same gate the layer selector
  // applies: below it we skip fetching and keep the layers hidden, so a
  // country-sized viewport can't pull thousands of incidents.
  const minZoom = useOverlayMinZoom(OVERLAY_ID);
  const layerVisible = useOverlayLayerVisible(OVERLAY_ID);
  // This overlay's manifest declares no dataSources of its own — the feeds it
  // paints (NDW, Autobahn GmbH, Digitraffic, DriveBC, WZDx) are published by
  // the `openconditions` integration's provider registered under the shared
  // domain. Credit the domain, the same way overlay-traffic-flow does;
  // crediting this integration's own manifest registered nothing at all.
  useIntegrationDomainAttribution(CREDIT_DOMAIN, layerVisible);
  useOverlayExclusion(OVERLAY_ID, layerVisible);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const popupSelectionRef = useRef<{
    hits: MapGeoJSONFeature[];
    fallbackCoordinates: [number, number];
  } | null>(null);
  const viewNeedsRefreshRef = useRef(false);
  const eventsByDisplayIdRef = useRef<Map<string, RoadConditionEvent[]>>(new Map());
  const { publish: publishGeoJson, beginRequest } = useGeoJsonSourceDataBridge({
    mapRef,
    mapReady,
    styleVersion,
    visible: layerVisible,
  });
  const hasViewportDataRef = useRef(false);
  // Created once (lazy ref init, same pattern as the GeoJSON bridge below) so
  // it exists before any effect runs — including the mount-time fetch, which
  // must be able to record its bbox into the scheduler no matter which effect
  // fires first. See viewport-scheduler.ts for the scheduling policy itself.
  const schedulerRef = useRef<ViewportFetchScheduler | null>(null);
  // Keep the latest formatters/translator in refs so the imperative popup click
  // handler (bound once per effect) always uses the current prefs + locale.
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
  const localeRef = useRef(locale);
  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);
  // Legend filter state — threaded into the events query so filtering runs
  // server-side across every provider, not as client-side hiding.
  const filterKinds = useRoadConditionsStore((s) => s.kinds);
  const minSeverity = useRoadConditionsStore((s) => s.minSeverity);
  const horizon = useRoadConditionsStore((s) => s.horizon);
  const setViewportFetchStatus = useRoadConditionsStore((s) => s.setViewportFetchStatus);

  const refreshPopup = useCallback(
    (needsRefresh: boolean) => {
      const popup = popupRef.current;
      const selection = popupSelectionRef.current;
      if (!popup || !selection) return;
      const content = buildRoadConditionPopupHtml({
        ...selection,
        eventsByDisplayId: eventsByDisplayIdRef.current,
        formatDateTime: dtfRef.current.dateTime,
        formatDate: dtfRef.current.date,
        translate: (key, values) => tRef.current(key, values),
        locale: localeRef.current,
        atMs: Date.now(),
        needsRefresh,
        requireCurrentEvents: true,
      });
      if (content.groupCount === 0) {
        if (mapRef.current) removeMapOverlayPopup(mapRef.current, popup);
        popupRef.current = null;
        popupSelectionRef.current = null;
      } else popup.setHTML(content.html);
    },
    [mapRef],
  );

  const fetchData = useCallback(async () => {
    const map = mapRef.current;
    if (!map) {
      setViewportFetchStatus("idle");
      return;
    }
    const request = beginRequest();
    if (map.getZoom() < minZoom) {
      setViewportFetchStatus("idle");
      return;
    }
    setViewportFetchStatus("loading");
    viewNeedsRefreshRef.current = true;
    refreshPopup(true);
    const b = map.getBounds();
    schedulerRef.current?.recordFetch({
      west: b.getWest(),
      south: b.getSouth(),
      east: b.getEast(),
      north: b.getNorth(),
    });
    const base = apiUrl.replace(/\/$/, "");
    const params = new URLSearchParams({
      bbox: `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`,
    });
    if (filterKinds.length > 0) params.set("kinds", filterKinds.join(","));
    if (minSeverity !== "all") params.set("minSeverity", minSeverity);
    const horizonDays = horizonDaysParam(horizon);
    if (horizonDays !== undefined) params.set("horizonDays", horizonDays);
    const url = `${base}/api/integrations/road-conditions/events?${params.toString()}`;
    try {
      const res = await fetch(url, { credentials: "include", signal: request.signal });
      if (!res.ok) throw new Error(`road conditions request failed (${res.status})`);
      const fc = (await res.json()) as { features?: RawFeature[] };
      if (!request.isCurrent()) return;
      const { data, eventsByDisplayId } = buildSources(
        Array.isArray(fc.features) ? fc.features : [],
        localeRef.current,
      );
      eventsByDisplayIdRef.current = eventsByDisplayId;
      viewNeedsRefreshRef.current = false;
      refreshPopup(false);
      publishGeoJson([{ sourceId: SOURCE, data }]);
      hasViewportDataRef.current = true;
      setViewportFetchStatus("ready");
    } catch {
      if (!request.isCurrent()) return;
      // Keep the last good source data visible while making the degraded state
      // explicit to the legend. A first-load failure has no stale data to keep.
      setViewportFetchStatus(hasViewportDataRef.current ? "stale" : "error");
      viewNeedsRefreshRef.current = true;
      refreshPopup(true);
    }
  }, [
    apiUrl,
    beginRequest,
    mapRef,
    filterKinds,
    minSeverity,
    horizon,
    minZoom,
    publishGeoJson,
    refreshPopup,
    setViewportFetchStatus,
  ]);

  // Bake a disc+glyph marker image on demand for each (glyph, severity) the
  // symbol layer requests. MapLibre v6 awaits this resolver before declaring
  // an image missing; the later `styleimagemissing` event can no longer supply
  // the requested image. The map carries the resolver across style rebuilds.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const resolveMissingImage = (id: string) => {
      if (map.hasImage(id)) return;
      const parsed = parseMarkerImageId(id);
      if (!parsed) return;
      const data = markerImageData(parsed.glyph, parsed.severity);
      if (data && !map.hasImage(id)) map.addImage(id, data, { pixelRatio: 2 });
    };
    map.setMissingStyleImageResolver(resolveMissingImage);
    return () => {
      map.setMissingStyleImageResolver(null);
    };
  }, [mapRef, mapReady]);

  // Add/remove source + layers, re-attaching after a style swap.
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
          // In-flight render — ignore.
        }
        unregisterLayerSlot(MARKER_LAYER);
        unregisterLayerSlot(LINE_LAYER);
        if (popupRef.current) {
          removeMapOverlayPopup(map, popupRef.current);
          popupRef.current = null;
        }
        return;
      }
      if (!map.isStyleLoaded()) {
        if (idleRetryScheduled) map.off("idle", sync);
        idleRetryScheduled = true;
        map.once("idle", sync);
        return;
      }
      idleRetryScheduled = false;
      try {
        if (!map.getSource(SOURCE)) {
          map.addSource(SOURCE, {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
        }
        if (!map.getLayer(LINE_LAYER)) {
          addLayerInSlot(
            map,
            {
              id: LINE_LAYER,
              type: "line",
              source: SOURCE,
              filter: ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
              minzoom: minZoom,
              layout: { "line-cap": "round", "line-join": "round" },
              paint: {
                "line-color": SEVERITY_LINE_COLOR,
                "line-width": ["interpolate", ["linear"], ["zoom"], 5, 3, 12, 6, 16, 9],
                "line-opacity": ROAD_CONDITION_LINE_OPACITY,
                "line-dasharray": ROAD_CONDITION_LINE_DASHARRAY,
              },
            },
            "conditions-lines",
            0,
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
              minzoom: minZoom,
              layout: {
                "icon-image": ["get", "_icon"],
                "icon-size": ["interpolate", ["linear"], ["zoom"], 5, 0.42, 10, 0.55, 16, 0.75],
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
                // Higher sort-key is drawn last (on top), so key by severity rank
                // — the worst condition's disc sits on top where markers overlap.
                "symbol-sort-key": ["get", "_sev"],
              },
              paint: {
                "icon-opacity": ROAD_CONDITION_MARKER_OPACITY,
              },
            },
            "overlay-markers",
            0,
          );
        }
      } catch {
        // Style not ready — styledata will retry.
      }
    };

    sync();
    map.on("styledata", sync);
    return () => {
      map.off("styledata", sync);
      if (idleRetryScheduled) map.off("idle", sync);
    };
  }, [mapReady, mapRef, styleVersion, layerVisible, minZoom]);

  // A followed navigation camera fires `moveend` on every animation frame —
  // up to 60/s for the whole length of a drive — so `fetchData` must never
  // hang directly off it. `fetchDataRef` lets the scheduler's `onDue`, which
  // is wired up once, always reach whichever `fetchData` closure is current.
  const fetchDataRef = useRef(fetchData);
  useEffect(() => {
    fetchDataRef.current = fetchData;
  }, [fetchData]);

  if (!schedulerRef.current) {
    schedulerRef.current = createViewportFetchScheduler({
      freshnessDeadlineMs: VIEWPORT_FRESHNESS_DEADLINE_MS,
      paddingFactor: VIEWPORT_PADDING_FACTOR,
      getViewport: () => boundsToViewportBox(mapRef.current),
      onDue: () => {
        void fetchDataRef.current();
      },
    });
  }

  // bbox-driven refetch on pan/zoom. The `moveend` handler itself only marks
  // the scheduler dirty — see viewport-scheduler.ts for the coalesced
  // evaluation that decides whether a refetch is actually due. Declared
  // before the immediate-fetch effect below so that, on a style change, this
  // effect's cleanup (which disposes stale scheduler timers) runs first and
  // the freshness timer the immediate fetch arms is the one left standing —
  // not the other way around.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    const scheduler = schedulerRef.current;
    if (!map || !mapReady || !layerVisible || !scheduler) return;
    const handleMoveEnd = () => scheduler.markDirty();
    map.on("moveend", handleMoveEnd);
    return () => {
      map.off("moveend", handleMoveEnd);
      // Nothing left to coalesce toward while hidden/unmounted/torn down for a
      // style swap — an idle map must not keep a scheduler timer alive.
      scheduler.dispose();
    };
  }, [mapReady, mapRef, styleVersion, layerVisible]);

  // Fetch independently from style synchronization. Style swaps should rebuild
  // sources/layers, while filters, viewport movement, and this style version
  // control which request is current.
  useEffect(() => {
    void styleVersion;

    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) {
      hasViewportDataRef.current = false;
      eventsByDisplayIdRef.current = new Map();
      setViewportFetchStatus("idle");
      return;
    }
    void fetchData();
  }, [mapReady, mapRef, styleVersion, layerVisible, fetchData, setViewportFetchStatus]);

  // Area markers and lines share one prioritized interaction registration. The
  // arbiter also owns the cursor so traffic flow cannot clear incident hover.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    const unregister = registerMapOverlayInteraction(map, {
      id: "road-conditions-area",
      layerIds: [MARKER_LAYER, LINE_LAYER],
      priority: 100,
      onClick: ({ event, features }) => {
        // Collect every marker near the click — not just the top one — so several
        // conditions stacked at the same spot all stay reachable in a single popup
        // (linked works often share a segment: roadworks + its lane closure land on
        // the same point). The radius is ~one marker-width so touching/overlapping
        // discs are grouped while genuinely separate incidents stay independent.
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

        popupSelectionRef.current = {
          hits,
          fallbackCoordinates: [event.lngLat.lng, event.lngLat.lat],
        };
        const content = buildRoadConditionPopupHtml({
          ...popupSelectionRef.current,
          atMs: Date.now(),
          needsRefresh: viewNeedsRefreshRef.current,
          requireCurrentEvents: true,
          eventsByDisplayId: eventsByDisplayIdRef.current,
          formatDateTime: dtfRef.current.dateTime,
          formatDate: dtfRef.current.date,
          translate: (key, values) => tRef.current(key, values),
          locale: localeRef.current,
        });
        if (content.groupCount === 0) return;
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
  }, [mapReady, mapRef, styleVersion, layerVisible]);

  // The area overlay stops at its min zoom; this covers the route at the zooms
  // below it, where a whole trip is on screen.
  return <RouteConditionsLayer />;
}

export default RoadConditionsLayer;
