"use client";

import {
  markerImageData,
  markerImageId,
  parseMarkerImageId,
  representativePoint,
} from "@integrations/road-conditions/markers";
import { type IncidentAlert, useSettingsStore } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useEffect } from "react";
import { useMap } from "@/lib/MapContext";
import { useNavIncidents } from "@/lib/navigation/useNavIncidents";
import { NAV_ROUTE_REMAINING_LAYER_ID } from "./NavigationRouteLayer";

type GeoJSONSource = maplibregl.GeoJSONSource;

export const NAV_INCIDENT_LINE_SOURCE_ID = "nav-incidents-lines-source";
export const NAV_INCIDENT_MARKER_SOURCE_ID = "nav-incidents-markers-source";
export const NAV_INCIDENT_LINE_LAYER_ID = "nav-incidents-lines";
export const NAV_INCIDENT_MARKER_LAYER_ID = "nav-incidents-markers";
export const NAV_INCIDENT_LINE_MIN_WIDTH = 12;
export const NAV_INCIDENT_LINE_WIDTH: maplibregl.ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  8,
  NAV_INCIDENT_LINE_MIN_WIDTH,
  12,
  14,
  16,
  16,
];

const SEVERITY_COLOR: maplibregl.ExpressionSpecification = [
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

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};

type IncidentMarkerFeature = GeoJSON.Feature<
  GeoJSON.Point,
  { severity: string; eventType: string; _icon: string; _sev: number; _id: string }
>;
type IncidentLineFeature = GeoJSON.Feature<
  GeoJSON.LineString | GeoJSON.MultiLineString,
  { severity: string }
>;

export interface NavIncidentFeatureCollections {
  markers: GeoJSON.FeatureCollection<GeoJSON.Point, IncidentMarkerFeature["properties"]>;
  lines: GeoJSON.FeatureCollection<
    GeoJSON.LineString | GeoJSON.MultiLineString,
    IncidentLineFeature["properties"]
  >;
}

/** Build the same marker glyphs and affected-road lines used by the full overlay. */
export function buildNavIncidentFeatureCollections(
  incidents: IncidentAlert[],
): NavIncidentFeatureCollections {
  const markers: IncidentMarkerFeature[] = [];
  const lines: IncidentLineFeature[] = [];

  for (const incident of incidents) {
    const geometry = incident.geometry;
    const markerPoints: [number, number][] =
      geometry.type === "MultiPoint"
        ? (geometry.coordinates as [number, number][])
        : geometry.type === "GeometryCollection"
          ? [incident.coord]
          : [
              representativePoint(geometry as { type: string; coordinates: unknown }) ??
                incident.coord,
            ];
    const markerProperties: IncidentMarkerFeature["properties"] = {
      severity: incident.severity,
      eventType: incident.eventType,
      _icon: markerImageId(incident.eventType, incident.severity),
      _sev: SEVERITY_RANK[incident.severity] ?? 0,
      _id: incident.id,
    };
    for (const coordinates of markerPoints) {
      markers.push({
        type: "Feature",
        properties: markerProperties,
        geometry: { type: "Point", coordinates },
      });
    }

    if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
      lines.push({
        type: "Feature",
        properties: { severity: incident.severity },
        geometry,
      });
    }
  }

  return {
    markers: { type: "FeatureCollection", features: markers },
    lines: { type: "FeatureCollection", features: lines },
  };
}

interface LayerOrderMap {
  getLayer(id: string): unknown;
  moveLayer(id: string, beforeId?: string): unknown;
}

/**
 * Keep the affected-road line immediately below the blue route and incident
 * symbols above it. Calling this after either layer set is recreated makes the
 * ordering deterministic across style swaps.
 */
export function orderNavIncidentLayers(map: LayerOrderMap): void {
  if (map.getLayer(NAV_INCIDENT_LINE_LAYER_ID) && map.getLayer(NAV_ROUTE_REMAINING_LAYER_ID)) {
    map.moveLayer(NAV_INCIDENT_LINE_LAYER_ID, NAV_ROUTE_REMAINING_LAYER_ID);
  }
  if (map.getLayer(NAV_INCIDENT_MARKER_LAYER_ID)) {
    map.moveLayer(NAV_INCIDENT_MARKER_LAYER_ID);
  }
}

/**
 * Renders route-relevant traffic incidents with the full overlay's affected
 * geometry and icon vocabulary. Lines are wider than and directly beneath the
 * blue route, leaving colored shoulders visible; symbols stay above the route.
 */
export function NavIncidentsLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const { incidents } = useNavIncidents();
  const incidentAlerts = useSettingsStore((state) => state.incidentAlerts);
  const visibleIncidents = incidentAlerts ? incidents : [];

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const onMissing = (event: { id: string }) => {
      if (map.hasImage(event.id)) return;
      const parsed = parseMarkerImageId(event.id);
      if (!parsed) return;
      const data = markerImageData(parsed.type, parsed.severity);
      if (data && !map.hasImage(event.id)) map.addImage(event.id, data, { pixelRatio: 2 });
    };
    map.on("styleimagemissing", onMissing);
    return () => {
      map.off("styleimagemissing", onMissing);
    };
  }, [mapRef, mapReady]);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    if (!map.getSource(NAV_INCIDENT_LINE_SOURCE_ID)) {
      map.addSource(NAV_INCIDENT_LINE_SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    if (!map.getSource(NAV_INCIDENT_MARKER_SOURCE_ID)) {
      map.addSource(NAV_INCIDENT_MARKER_SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    if (!map.getLayer(NAV_INCIDENT_LINE_LAYER_ID)) {
      map.addLayer(
        {
          id: NAV_INCIDENT_LINE_LAYER_ID,
          type: "line",
          source: NAV_INCIDENT_LINE_SOURCE_ID,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": SEVERITY_COLOR,
            "line-width": NAV_INCIDENT_LINE_WIDTH,
            "line-opacity": 0.8,
          },
        },
        map.getLayer(NAV_ROUTE_REMAINING_LAYER_ID) ? NAV_ROUTE_REMAINING_LAYER_ID : undefined,
      );
    }
    if (!map.getLayer(NAV_INCIDENT_MARKER_LAYER_ID)) {
      map.addLayer({
        id: NAV_INCIDENT_MARKER_LAYER_ID,
        type: "symbol",
        source: NAV_INCIDENT_MARKER_SOURCE_ID,
        layout: {
          "icon-image": ["get", "_icon"],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 12, 0.65, 16, 0.8],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "symbol-sort-key": ["get", "_sev"],
        },
      });
    }
    orderNavIncidentLayers(map);
  }, [mapRef, mapReady, styleVersion]);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map) return;
    const markerSource = map?.getSource(NAV_INCIDENT_MARKER_SOURCE_ID);
    const lineSource = map?.getSource(NAV_INCIDENT_LINE_SOURCE_ID);
    if (markerSource?.type !== "geojson" || lineSource?.type !== "geojson") return;
    const data = buildNavIncidentFeatureCollections(visibleIncidents);
    (markerSource as GeoJSONSource).setData(data.markers);
    (lineSource as GeoJSONSource).setData(data.lines);
    orderNavIncidentLayers(map);
  }, [mapRef, visibleIncidents, styleVersion]);

  return null;
}
