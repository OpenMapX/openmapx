"use client";

import {
  type RoadConditionEvent,
  roadConditionFeatureToEvent,
  useOverlayExclusion,
} from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, MapGeoJSONFeature } from "maplibre-gl";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import {
  registerMapOverlayInteraction,
  removeMapOverlayPopup,
} from "@/integration-api/map/mapInteractionArbiter";
import { useGeoJsonSourceDataBridge } from "@/integration-api/map/useGeoJsonSourceDataBridge";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useOverlayMinZoom } from "@/integration-api/overlay/overlayZoomGate";
import { useOverlayLayerVisible } from "@/integration-api/overlay/useOverlayStoreState";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";
import { usePopupCreditOptions } from "@/integration-api/runtime/usePopupCreditOptions";
import { roadConditionAttributions } from "./attributions";
import { buildRoadConditionDisplayGroups, buildRoadConditionFeatures } from "./display";
// The named import also runs the module side-effect that registers the
// "road-conditions" overlay store (shared by the layer selector + legend).
import {
  closeIncidentPopup,
  type IncidentLayerIds,
  incidentClickHits,
  incidentLayerGroup,
  openIncidentPopup,
} from "./incident-layers";
import { useIncidentsVisible } from "./incidents-visible";
import { markerImageData, parseMarkerImageId } from "./markers";
import { buildRoadConditionPopupHtml } from "./popup";
import { useRestoredRoadConditionsChoices } from "./restore-choices";
import { RouteConditionsLayer } from "./route-layer";
import { RoadSourceLayers } from "./source-layers";
import { horizonDaysParam, useRoadConditionsStore } from "./store";
import {
  createViewportFetchScheduler,
  type ViewportBox,
  type ViewportFetchScheduler,
} from "./viewport-scheduler";

type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];

const OVERLAY_ID = "road-conditions";
const AREA_LAYERS: IncidentLayerIds = {
  source: "omx-road-conditions",
  line: "omx-road-conditions-line",
  marker: "omx-road-conditions-markers",
};
const CREDIT_LAYERS = [AREA_LAYERS.line, AREA_LAYERS.marker];

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
      features: buildRoadConditionFeatures(groups, locale, atMs, (events) =>
        roadConditionAttributions(events),
      ),
    } as GeoJsonData,
    eventsByDisplayId,
  };
}

export function RoadConditionsLayer() {
  useRestoredRoadConditionsChoices();
  const { mapRef, mapReady, styleVersion } = useMap();
  const { apiUrl } = useEnv();
  // Declared in this integration's manifest, the same gate the layer selector
  // applies: below it we skip fetching and keep the layers hidden, so a
  // country-sized viewport can't pull thousands of incidents.
  const minZoom = useOverlayMinZoom(OVERLAY_ID);
  const overlayVisible = useOverlayLayerVisible(OVERLAY_ID);
  // The incidents are one of the overlay's layers; the reader can hide them
  // and keep only, say, road weather.
  const layerVisible = useIncidentsVisible();
  useRenderedMapAttributions("road-conditions-area", CREDIT_LAYERS, layerVisible);
  useOverlayExclusion(OVERLAY_ID, overlayVisible);
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
  const creditOptions = usePopupCreditOptions();
  const creditOptionsRef = useRef(creditOptions);
  useEffect(() => {
    creditOptionsRef.current = creditOptions;
  }, [creditOptions]);
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
  const hiddenKinds = useRoadConditionsStore((s) => s.hiddenKinds);
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
        formatRelative: dtfRef.current.relative,
        creditOptions: creditOptionsRef.current,
        translate: (key, values) => tRef.current(key, values),
        locale: localeRef.current,
        atMs: Date.now(),
        needsRefresh,
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
    if (hiddenKinds.length > 0) params.set("excludeKinds", hiddenKinds.join(","));
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
        Date.now(),
      );
      eventsByDisplayIdRef.current = eventsByDisplayId;
      viewNeedsRefreshRef.current = false;
      refreshPopup(false);
      publishGeoJson([{ sourceId: AREA_LAYERS.source, data }]);
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
    hiddenKinds,
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

  useMapLayerGroup(
    useMemo(
      () =>
        layerVisible
          ? incidentLayerGroup(AREA_LAYERS, {
              zoom: { minzoom: minZoom },
              order: 0,
              lineWidth: ["interpolate", ["linear"], ["zoom"], 5, 3, 12, 6, 16, 9],
              iconSize: ["interpolate", ["linear"], ["zoom"], 5, 0.42, 10, 0.55, 16, 0.75],
            })
          : null,
      [layerVisible, minZoom],
    ),
  );

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
      layerIds: [AREA_LAYERS.marker, AREA_LAYERS.line],
      priority: 100,
      onClick: (interaction) => {
        const hits = incidentClickHits(map, AREA_LAYERS.marker, interaction);
        if (hits.length === 0) return;

        const { lngLat } = interaction.event;
        const selection = {
          hits,
          fallbackCoordinates: [lngLat.lng, lngLat.lat] as [number, number],
        };
        popupSelectionRef.current = selection;
        openIncidentPopup(map, popupRef, {
          ...selection,
          atMs: Date.now(),
          needsRefresh: viewNeedsRefreshRef.current,
          eventsByDisplayId: eventsByDisplayIdRef.current,
          formatDateTime: dtfRef.current.dateTime,
          formatDate: dtfRef.current.date,
          formatRelative: dtfRef.current.relative,
          creditOptions: creditOptionsRef.current,
          translate: (key, values) => tRef.current(key, values),
          locale: localeRef.current,
        });
      },
    });
    return () => {
      unregister();
      closeIncidentPopup(map, popupRef);
    };
  }, [mapReady, mapRef, styleVersion, layerVisible]);

  // The area overlay stops at its min zoom; this covers the route at the zooms
  // below it, where a whole trip is on screen.
  return (
    <>
      <RouteConditionsLayer />
      <RoadSourceLayers />
    </>
  );
}

export default RoadConditionsLayer;
