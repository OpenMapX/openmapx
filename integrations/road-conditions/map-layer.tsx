"use client";

import {
  formatDuration,
  type RoadConditionEvent,
  useDebouncedCallback,
  useOverlayExclusion,
} from "@openmapx/core";
import type { GeoJSONSource, MapLayerMouseEvent } from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef } from "react";
import { addLayerInSlot, unregisterLayerSlot } from "@/components/map/layers/layerStack";
import { buildStackedPopupCard, type PopupCardSpec } from "@/components/map/overlay/popupCard";
import { useOverlayLayerVisible } from "@/components/map/overlay/useOverlayStoreState";
import { useEnv } from "@/lib/EnvProvider";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { useMap } from "@/lib/MapContext";
import { useOverlayMinZoom } from "@/lib/overlayZoomGate";
import { useDateTimeFormat } from "@/lib/useDateTimeFormat";
import { useIntegrationDomainAttribution } from "@/lib/useIntegrationAttribution";
import { buildRoadConditionDisplayGroups, type RoadConditionDisplayGroup } from "./display";
import { isUnconfirmedCrowd } from "./evidence";
import { markerImageData, markerImageId, parseMarkerImageId } from "./markers";
import { RouteConditionsLayer } from "./route-layer";
// The named import also runs the module side-effect that registers the
// "road-conditions" overlay store (shared by the layer selector + legend).
import { horizonDaysParam, useRoadConditionsStore } from "./store";

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

/** Popup card layout — defined in code, full freedom (no manifest schema). */
const POPUP_SPEC: PopupCardSpec = {
  titleField: "headline",
  severityField: "severity",
  attributionField: "attribution",
  rows: [
    { field: "type", labelKey: "panel.type", format: "label", variant: "chip" },
    { field: "roadState", labelKey: "panel.roadState", format: "label", variant: "chip" },
    { field: "roads", labelKey: "panel.roads", variant: "row" },
    { field: "recordId", label: "Source record", variant: "row" },
    // Structured validity window (from the feed's validFrom/validTo, not the
    // free-text description — many feeds don't put it in the text). Pre-formatted
    // into `validity` at click time.
    { field: "validity", labelKey: "panel.validity", variant: "row" },
    // "Starts ⟨date⟩", set at click time for conditions that haven't begun —
    // without it a widened horizon reads the same as what's in effect now.
    { field: "startsAt", variant: "row" },
    // Pre-formatted "+X min" delay (Verlustzeit); set at click time when >= 60 s.
    { field: "delayText", labelKey: "panel.delay", variant: "row" },
    { field: "description", labelKey: "panel.description", variant: "block" },
  ],
};

/** Numeric severity rank — drives `symbol-sort-key` so the worst condition
 * renders on top where markers overlap, and orders the stacked popup. */
const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};

interface ScheduleEntry {
  startTime?: string;
  endTime?: string;
  startDate?: string;
  endDate?: string;
  byDay?: string[];
}

/**
 * Format the structured validity for the popup. A recurring `schedule` (a
 * schema.org Schedule, e.g. a nightly closure) is shown as its day(s) + band +
 * date range, e.g. "Mo, Tu, We, 08:00–17:00, 29 Jun 2026 – 1 Jul 2026";
 * otherwise the absolute from–until range, e.g.
 * "10 Jul 2026, 22:00 – 13 Jul 2026, 05:00". An open end is shown as "…".
 * Returns "" when nothing is known (ongoing / undated) so the row drops.
 * Schedule times are the source's local clock (`scheduleTimezone`), shown as-is.
 */
function formatValidity(
  scheduleJson: unknown,
  from: unknown,
  to: unknown,
  fmtDateTime: (value: string | number | Date) => string,
  fmtDate: (value: string | number | Date) => string,
): string {
  if (typeof scheduleJson === "string" && scheduleJson) {
    try {
      const windows = JSON.parse(scheduleJson) as ScheduleEntry[];
      const hhmm = (t?: string) => (t ? t.slice(0, 5) : "");
      const parts = windows
        .map((w) => {
          const days = w.byDay && w.byDay.length > 0 ? w.byDay.join(", ") : "";
          const band =
            w.startTime && w.endTime
              ? `${hhmm(w.startTime)}–${hhmm(w.endTime)}`
              : w.startTime
                ? `from ${hhmm(w.startTime)}`
                : "";
          const range =
            w.startDate && w.endDate
              ? `${fmtDate(w.startDate)} – ${fmtDate(w.endDate)}`
              : w.startDate
                ? fmtDate(w.startDate)
                : "";
          return [days, band, range].filter(Boolean).join(", ");
        })
        .filter(Boolean);
      if (parts.length > 0) return parts.join("; ");
    } catch {
      // Malformed schedule → fall through to the plain range.
    }
  }
  const f = typeof from === "string" && from ? fmtDateTime(from) : "";
  const t = typeof to === "string" && to ? fmtDateTime(to) : "";
  if (!f && !t) return "";
  return `${f || "…"} – ${t || "…"}`;
}

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

/** Whether a raw feature describes a condition that has not started yet. */
function isFutureCondition(p: { isForecast?: unknown; validFrom?: unknown }): boolean {
  if (p.isForecast === true) return true;
  if (typeof p.validFrom !== "string") return false;
  const from = Date.parse(p.validFrom);
  return !Number.isNaN(from) && from > Date.now();
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
  const future = group.events.every(isFutureCondition);
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

function popupProperties(
  event: RoadConditionEvent,
  displayId: string,
  includeRecordId: boolean,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    headline: event.headline,
    type: event.type,
    severity: event.severity,
    attribution: attributionString(event.attribution),
    _id: event.id,
    _displayId: displayId,
    _sev: SEVERITY_RANK[event.severity] ?? 0,
    future: isFutureCondition(event),
  };
  if (includeRecordId) properties.recordId = event.id;
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

export function buildRoadConditionPopupEntries(
  displayId: string,
  events: RoadConditionEvent[],
): Record<string, unknown>[] {
  if (events.length === 0) return [];
  const childEntries = events.map((event) => popupProperties(event, displayId, events.length > 1));
  if (events.length === 1) return childEntries;

  const representative = events.reduce((best, event) => {
    const bestRank = SEVERITY_RANK[best.severity] ?? 0;
    const eventRank = SEVERITY_RANK[event.severity] ?? 0;
    return eventRank > bestRank ? event : best;
  });
  const summary = popupProperties(representative, displayId, false);
  summary.recordId = `${events.length} source records`;

  const same = (field: keyof RoadConditionEvent) =>
    events.every((event) => JSON.stringify(event[field]) === JSON.stringify(events[0]?.[field]));
  if (!same("headline"))
    summary.headline = `${representative.headline} (${events.length} related records)`;
  if (!same("description")) delete summary.description;
  if (!same("roads")) delete summary.roads;
  if (!same("validFrom")) {
    const starts = events
      .map((event) => event.validFrom)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    if (starts.length > 0) {
      summary.validFrom = starts.reduce((earliest, value) =>
        Date.parse(value) < Date.parse(earliest) ? value : earliest,
      );
    } else {
      delete summary.validFrom;
    }
  }
  if (!same("validTo")) {
    const ends = events
      .map((event) => event.validTo)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    if (ends.length > 0) {
      summary.validTo = ends.reduce((latest, value) =>
        Date.parse(value) > Date.parse(latest) ? value : latest,
      );
    } else {
      delete summary.validTo;
    }
  }
  if (!same("schedule")) delete summary.schedule;
  if (!same("delaySeconds")) delete summary.delaySeconds;

  return [summary, ...childEntries];
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
          future: group.events.every(isFutureCondition),
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

  const fetchData = useCallback(async () => {
    const map = mapRef.current;
    if (!map || map.getZoom() < minZoom) return;
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
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return;
      const fc = (await res.json()) as { features?: RawFeature[] };
      const { markers, lines, eventsByDisplayId } = buildSources(
        Array.isArray(fc.features) ? fc.features : [],
      );
      eventsByDisplayIdRef.current = eventsByDisplayId;
      (map.getSource(MARKER_SOURCE) as GeoJSONSource | undefined)?.setData(markers);
      (map.getSource(LINE_SOURCE) as GeoJSONSource | undefined)?.setData(lines);
    } catch {
      // Silent fetch failure — overlay stays as-is.
    }
  }, [apiUrl, mapRef, filterTypes, minSeverity, horizon, minZoom]);

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

    const sync = () => {
      if (!layerVisible) {
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
        popupRef.current?.remove();
        return;
      }
      if (!map.isStyleLoaded()) {
        map.once("idle", sync);
        return;
      }
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
                "line-opacity": ["case", ["get", "future"], 0.45, 0.7],
                "line-dasharray": [
                  "case",
                  ["get", "future"],
                  ["literal", [2, 1.5]],
                  ["literal", [1]],
                ],
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
                "icon-opacity": ["case", ["get", "future"], 0.55, 1],
              },
            },
            "overlay-markers",
            0,
          );
          INTERACTIVE_LAYER_IDS.add(MARKER_LAYER);
        }
        void fetchData();
      } catch {
        // Style not ready — styledata will retry.
      }
    };

    sync();
    map.on("styledata", sync);
    return () => {
      map.off("styledata", sync);
    };
  }, [mapReady, mapRef, styleVersion, layerVisible, fetchData, minZoom]);

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

  // Click popup + hover cursor on markers.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    const onClick = (e: MapLayerMouseEvent) => {
      // Collect every marker near the click — not just the top one — so several
      // conditions stacked at the same spot all stay reachable in a single popup
      // (linked works often share a segment: roadworks + its lane closure land on
      // the same point). The radius is ~one marker-width so touching/overlapping
      // discs are grouped while genuinely separate incidents stay independent.
      const r = 24;
      const box: [[number, number], [number, number]] = [
        [e.point.x - r, e.point.y - r],
        [e.point.x + r, e.point.y + r],
      ];
      const hits = map.getLayer(MARKER_LAYER)
        ? map.queryRenderedFeatures(box, { layers: [MARKER_LAYER] })
        : (e.features ?? []);
      if (hits.length === 0) return;

      // Dedupe by display identity (one MultiPoint group renders a marker per
      // endpoint), resolve grouped source records from memory, format each
      // condition's validity, then order most-severe first.
      const seen = new Set<string>();
      const entries: Record<string, unknown>[] = [];
      let recordCount = 0;
      for (const h of hits) {
        const p = (h.properties ?? {}) as Record<string, unknown>;
        const displayId = String(p._displayId ?? p._id ?? p.headline ?? "");
        if (seen.has(displayId)) continue;
        seen.add(displayId);

        const childEvents = eventsByDisplayIdRef.current.get(displayId);
        const sourceEntries = childEvents?.length
          ? buildRoadConditionPopupEntries(displayId, childEvents)
          : [p];
        recordCount += childEvents?.length ?? 1;
        for (const sourceEntry of sourceEntries) {
          const validity = formatValidity(
            sourceEntry.schedule,
            sourceEntry.validFrom,
            sourceEntry.validTo,
            dtfRef.current.dateTime,
            dtfRef.current.date,
          );
          const startsAt =
            sourceEntry.future === true && typeof sourceEntry.validFrom === "string"
              ? tRef.current("startsAt", {
                  date: dtfRef.current.dateTime(sourceEntry.validFrom),
                })
              : undefined;
          const delaySeconds = Number(sourceEntry.delaySeconds);
          const delayText =
            Number.isFinite(delaySeconds) && delaySeconds >= 60
              ? `+${formatDuration(delaySeconds)}`
              : undefined;
          entries.push({
            ...sourceEntry,
            ...(validity ? { validity } : {}),
            ...(startsAt ? { startsAt } : {}),
            ...(delayText ? { delayText } : {}),
          });
        }
      }
      entries.sort((a, b) => (Number(b._sev) || 0) - (Number(a._sev) || 0));

      const top = e.features?.[0];
      const coords: [number, number] =
        top?.geometry?.type === "Point"
          ? (top.geometry.coordinates as [number, number])
          : [e.lngLat.lng, e.lngLat.lat];

      popupRef.current?.remove();
      popupRef.current = new maplibregl.Popup({
        closeButton: true,
        maxWidth: "300px",
        className: "omx-popup",
      })
        .setLngLat(coords)
        .setHTML(
          buildStackedPopupCard(
            POPUP_SPEC,
            entries,
            (k) => tRef.current(k),
            tRef.current("panel.conditionsHere", { count: recordCount }),
          ),
        )
        .addTo(map);
    };

    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      if (!map.getLayer(MARKER_LAYER)) return;
      const hit = map.queryRenderedFeatures(e.point, { layers: [MARKER_LAYER] });
      map.getCanvasContainer().style.cursor = hit.length > 0 ? "pointer" : "";
    };

    map.on("click", MARKER_LAYER, onClick);
    map.on("mousemove", onMouseMove);
    return () => {
      map.off("click", MARKER_LAYER, onClick);
      map.off("mousemove", onMouseMove);
      map.getCanvasContainer().style.cursor = "";
      popupRef.current?.remove();
    };
  }, [mapReady, mapRef, styleVersion, layerVisible]);

  // Deregister the interactive layer id on unmount.
  useEffect(() => {
    return () => {
      INTERACTIVE_LAYER_IDS.delete(MARKER_LAYER);
    };
  }, []);

  // The area overlay stops at its min zoom; this covers the route at the zooms
  // below it, where a whole trip is on screen.
  return <RouteConditionsLayer />;
}

export default RoadConditionsLayer;
