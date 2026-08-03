"use client";

import { type RoadConditionEvent, useDebouncedCallback, useOverlayExclusion } from "@openmapx/core";
import type { GeoJSONSource, MapGeoJSONFeature } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef } from "react";
import { addLayerInSlot, unregisterLayerSlot } from "@/components/map/layers/layerStack";
import {
  registerMapOverlayInteraction,
  removeMapOverlayPopup,
  replaceMapOverlayPopup,
} from "@/components/map/overlay/mapInteractionArbiter";
import { useOverlayLayerVisible } from "@/components/map/overlay/useOverlayStoreState";
import { useEnv } from "@/lib/EnvProvider";
import { useMap } from "@/lib/MapContext";
import { useOverlayMinZoom } from "@/lib/overlayZoomGate";
import { useDateTimeFormat } from "@/lib/useDateTimeFormat";
import { useIntegrationDomainAttribution } from "@/lib/useIntegrationAttribution";
import { buildRoadConditionDisplayGroups, type RoadConditionDisplayGroup } from "./display";
import { isUnconfirmedCrowd } from "./evidence";
import { markerImageData, markerImageId, parseMarkerImageId } from "./markers";
import {
  buildRoadConditionPopupHtml,
  ROAD_CONDITION_SEVERITY_RANK as SEVERITY_RANK,
} from "./popup";
import { RouteConditionsLayer } from "./route-layer";
// The named import also runs the module side-effect that registers the
// "road-conditions" overlay store (shared by the layer selector + legend).
import { horizonDaysParam, useRoadConditionsStore } from "./store";
import {
  isFutureRoadCondition,
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
const MARKER_SOURCE = "omx-road-conditions-markers";
const LINE_SOURCE = "omx-road-conditions-lines";
const LINE_LAYER = "omx-road-conditions-line";
const MARKER_LAYER = "omx-road-conditions-markers";

/** Affected-segment line color by severity (matches the marker disc ramp). */
const SEVERITY_LINE_COLOR: maplibregl.ExpressionSpecification = [
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
];

/** Collapse the attribution object into a single credit string for the popup. */
function attributionString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const provider = typeof o.provider === "string" ? o.provider : "";
    const license = typeof o.license === "string" ? o.license : "";
    return provider && license ? `${provider} · ${license}` : provider || license;
  }
  return "";
}

export interface RawFeature {
  geometry?: { type: string; coordinates: unknown } | null;
  properties?: Record<string, unknown> | null;
}

export interface RoadConditionDisplaySources {
  markers: GeoJsonData;
  lines: GeoJsonData;
  /** In-memory child records used to resolve a grouped marker's popup. */
  eventsByDisplayId: Map<string, RoadConditionEvent[]>;
}

function rawFeatureToEvent(feature: RawFeature): RoadConditionEvent | null {
  const properties = feature.properties ?? {};
  if (!feature.geometry) return null;

  const headline = String(properties.headline ?? "");
  const id = String(properties.id ?? headline);
  if (!id) return null;

  const event: RoadConditionEvent = {
    id,
    source: String(properties.source ?? "unknown"),
    provider: String(properties.provider ?? "unknown"),
    type: String(properties.type ?? "other") as RoadConditionEvent["type"],
    severity: String(properties.severity ?? "unknown") as RoadConditionEvent["severity"],
    geometry: feature.geometry as RoadConditionEvent["geometry"],
    headline,
  };

  if (typeof properties.groupId === "string" && properties.groupId.length > 0) {
    event.groupId = properties.groupId;
  }
  if (typeof properties.description === "string") event.description = properties.description;
  if (typeof properties.delaySeconds === "number") event.delaySeconds = properties.delaySeconds;
  if (typeof properties.roadState === "string") {
    event.roadState = properties.roadState as RoadConditionEvent["roadState"];
  }
  if (Array.isArray(properties.roads)) {
    event.roads = properties.roads as RoadConditionEvent["roads"];
  }
  if (typeof properties.validFrom === "string") event.validFrom = properties.validFrom;
  if (typeof properties.validTo === "string") event.validTo = properties.validTo;
  if (Array.isArray(properties.schedule)) {
    event.schedule = properties.schedule as RoadConditionEvent["schedule"];
  }
  if (properties.attribution && typeof properties.attribution === "object") {
    event.attribution = properties.attribution as RoadConditionEvent["attribution"];
  }
  if (properties.originKind === "feed" || properties.originKind === "crowd") {
    event.originKind = properties.originKind;
  }
  if (typeof properties.evidenceState === "string") {
    event.evidenceState = properties.evidenceState;
  }
  if (typeof properties.routingEligible === "boolean") {
    event.routingEligible = properties.routingEligible;
  }
  if (typeof properties.confidenceScore === "number") {
    event.confidenceScore = properties.confidenceScore;
  }
  if (typeof properties.isForecast === "boolean") event.isForecast = properties.isForecast;
  if (typeof properties.isPlanned === "boolean") event.isPlanned = properties.isPlanned;

  return event;
}

function mostSevereEvent(group: RoadConditionDisplayGroup): RoadConditionEvent {
  return group.events.reduce((best, event) => {
    const bestRank = SEVERITY_RANK[best.severity] ?? 0;
    const eventRank = SEVERITY_RANK[event.severity] ?? 0;
    return eventRank > bestRank ? event : best;
  });
}

function roadNames(event: RoadConditionEvent): string | undefined {
  const names = (event.roads ?? [])
    .map((road) => {
      const raw = road as unknown as { name?: unknown; ref?: unknown };
      return String(raw.ref ?? raw.name ?? "").trim();
    })
    .filter(Boolean);
  return names.length > 0 ? [...new Set(names)].join(", ") : undefined;
}

function markerProperties(
  group: RoadConditionDisplayGroup,
  event: RoadConditionEvent,
): Record<string, unknown> {
  const future = group.events.every(isFutureRoadCondition);
  const properties: Record<string, unknown> = {
    headline: event.headline,
    type: event.type,
    severity: event.severity,
    attribution: attributionString(event.attribution),
    _icon: markerImageId(event.type, event.severity),
    // Keep the canonical id for compatibility with existing ungrouped marker
    // consumers; `_displayId` is the presentation identity used for grouping.
    _id: group.events.length === 1 ? event.id : group.displayId,
    _displayId: group.displayId,
    _sev: SEVERITY_RANK[event.severity] ?? 0,
    _unconfirmed: group.events.some((item) =>
      isUnconfirmedCrowd({
        originKind: item.originKind ?? null,
        evidenceState: item.evidenceState ?? null,
      }),
    ),
    future,
  };
  if (event.roadState) properties.roadState = event.roadState;
  if (event.validFrom) properties.validFrom = event.validFrom;
  if (event.validTo) properties.validTo = event.validTo;
  if (event.schedule && event.schedule.length > 0) {
    properties.schedule = JSON.stringify(event.schedule);
  }
  if (event.description) properties.description = event.description;
  if (typeof event.delaySeconds === "number") properties.delaySeconds = event.delaySeconds;
  const roads = roadNames(event);
  if (roads) properties.roads = roads;
  return properties;
}

/**
 * Build the marker + line source data from the raw /events FeatureCollection:
 * one marker per display group (or every real endpoint where a group has no
 * line), and one line feature per display group. Child event records stay in an
 * in-memory lookup for popup resolution; full child payloads are never placed
 * in MapLibre feature properties.
 */
export function buildSources(features: RawFeature[]): RoadConditionDisplaySources {
  const markerFeatures: unknown[] = [];
  const lineFeatures: unknown[] = [];
  const events = features
    .map(rawFeatureToEvent)
    .filter((event): event is RoadConditionEvent => event !== null);
  const groups = buildRoadConditionDisplayGroups(events);
  const eventsByDisplayId = new Map(
    groups.map((group) => [group.displayId, group.events] as const),
  );

  for (const group of groups) {
    const event = mostSevereEvent(group);
    const properties = markerProperties(group, event);
    for (const point of group.markerCoordinates) {
      markerFeatures.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: point },
        properties,
      });
    }
    if (group.lineGeometry) {
      lineFeatures.push({
        type: "Feature",
        geometry: group.lineGeometry,
        properties: {
          severity: event.severity,
          future: group.events.every(isFutureRoadCondition),
          _displayId: group.displayId,
        },
      });
    }
  }

  return {
    markers: { type: "FeatureCollection", features: markerFeatures } as GeoJsonData,
    lines: { type: "FeatureCollection", features: lineFeatures } as GeoJsonData,
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
  // the external `road-conditions-openconditions` provider registered under the
  // shared domain. Credit the domain, the same way overlay-traffic-flow does;
  // crediting this integration's own manifest registered nothing at all.
  useIntegrationDomainAttribution(CREDIT_DOMAIN, layerVisible);
  useOverlayExclusion(OVERLAY_ID, layerVisible);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const eventsByDisplayIdRef = useRef<Map<string, RoadConditionEvent[]>>(new Map());
  const requestGenerationRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const hasViewportDataRef = useRef(false);
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
  // Legend filter state — threaded into the events query so filtering runs
  // server-side across every provider, not as client-side hiding.
  const filterTypes = useRoadConditionsStore((s) => s.types);
  const minSeverity = useRoadConditionsStore((s) => s.minSeverity);
  const horizon = useRoadConditionsStore((s) => s.horizon);
  const setViewportFetchStatus = useRoadConditionsStore((s) => s.setViewportFetchStatus);

  const fetchData = useCallback(async () => {
    const map = mapRef.current;
    if (!map || map.getZoom() < minZoom) {
      setViewportFetchStatus("idle");
      return;
    }
    const generation = ++requestGenerationRef.current;
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setViewportFetchStatus("loading");
    const b = map.getBounds();
    const base = apiUrl.replace(/\/$/, "");
    const params = new URLSearchParams({
      bbox: `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`,
    });
    if (filterTypes.length > 0) params.set("types", filterTypes.join(","));
    if (minSeverity !== "all") params.set("minSeverity", minSeverity);
    const horizonDays = horizonDaysParam(horizon);
    if (horizonDays !== undefined) params.set("horizonDays", horizonDays);
    const url = `${base}/api/integrations/road-conditions/events?${params.toString()}`;
    try {
      const res = await fetch(url, { credentials: "include", signal: controller.signal });
      if (!res.ok) throw new Error(`road conditions request failed (${res.status})`);
      const fc = (await res.json()) as { features?: RawFeature[] };
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
      const { markers, lines, eventsByDisplayId } = buildSources(
        Array.isArray(fc.features) ? fc.features : [],
      );
      eventsByDisplayIdRef.current = eventsByDisplayId;
      (map.getSource(MARKER_SOURCE) as GeoJSONSource | undefined)?.setData(markers);
      (map.getSource(LINE_SOURCE) as GeoJSONSource | undefined)?.setData(lines);
      hasViewportDataRef.current = true;
      setViewportFetchStatus("ready");
    } catch {
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
      // Keep the last good source data visible while making the degraded state
      // explicit to the legend. A first-load failure has no stale data to keep.
      setViewportFetchStatus(hasViewportDataRef.current ? "stale" : "error");
    }
  }, [apiUrl, mapRef, filterTypes, minSeverity, horizon, minZoom, setViewportFetchStatus]);

  // Bake a disc+glyph marker image on demand for each (type, severity) the
  // symbol layer requests. Synchronous canvas render → no flicker, no warnings.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const onMissing = (e: { id: string }) => {
      if (map.hasImage(e.id)) return;
      const parsed = parseMarkerImageId(e.id);
      if (!parsed) return;
      const data = markerImageData(parsed.type, parsed.severity);
      if (data && !map.hasImage(e.id)) map.addImage(e.id, data, { pixelRatio: 2 });
    };
    map.on("styleimagemissing", onMissing);
    return () => {
      map.off("styleimagemissing", onMissing);
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
          if (map.getSource(MARKER_SOURCE)) map.removeSource(MARKER_SOURCE);
          if (map.getSource(LINE_SOURCE)) map.removeSource(LINE_SOURCE);
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
        if (!map.getSource(LINE_SOURCE)) {
          map.addSource(LINE_SOURCE, {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
        }
        if (!map.getSource(MARKER_SOURCE)) {
          map.addSource(MARKER_SOURCE, {
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
              source: LINE_SOURCE,
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
              source: MARKER_SOURCE,
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

  // Fetch independently from style synchronization. Style swaps should rebuild
  // sources/layers, while filters, viewport movement, and this style version
  // control which request is current.
  useEffect(() => {
    void styleVersion;

    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) {
      requestGenerationRef.current += 1;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      hasViewportDataRef.current = false;
      eventsByDisplayIdRef.current = new Map();
      setViewportFetchStatus("idle");
      return;
    }
    void fetchData();
  }, [mapReady, mapRef, styleVersion, layerVisible, fetchData, setViewportFetchStatus]);

  useEffect(() => {
    return () => {
      requestGenerationRef.current += 1;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, []);

  // bbox-driven refetch on pan/zoom.
  const debouncedFetch = useDebouncedCallback(() => fetchData(), 800);
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;
    map.on("moveend", debouncedFetch);
    return () => {
      map.off("moveend", debouncedFetch);
    };
  }, [mapReady, mapRef, styleVersion, layerVisible, debouncedFetch]);

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

        const content = buildRoadConditionPopupHtml({
          hits,
          fallbackCoordinates: [event.lngLat.lng, event.lngLat.lat],
          eventsByDisplayId: eventsByDisplayIdRef.current,
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
  }, [mapReady, mapRef, styleVersion, layerVisible]);

  // The area overlay stops at its min zoom; this covers the route at the zooms
  // below it, where a whole trip is on screen.
  return <RouteConditionsLayer />;
}

export default RoadConditionsLayer;
