"use client";

import type { DataDrivenPropertyValueSpecification, MapGeoJSONFeature } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";
import type { RefObject } from "react";
import {
  type MapOverlayInteractionEvent,
  removeMapOverlayPopup,
  replaceMapOverlayPopup,
} from "@/integration-api/map/mapInteractionArbiter";
import { EMPTY_FEATURE_COLLECTION, type MapLayerGroup } from "@/integration-api/map/mapLayerGroup";
import { buildRoadConditionPopupHtml, type RoadConditionPopupInput } from "./popup";
import { SEVERITY_LINE_COLOR } from "./severity";
import {
  ROAD_CONDITION_LINE_DASHARRAY,
  ROAD_CONDITION_LINE_OPACITY,
  ROAD_CONDITION_MARKER_OPACITY,
} from "./visual-style";

export interface IncidentLayerIds {
  source: string;
  line: string;
  marker: string;
}

export interface IncidentLayerOptions {
  /** The area overlay starts at the overlay's min zoom; the route layer stops there. */
  zoom: { minzoom: number } | { maxzoom: number };
  /** Order within the line and marker slots. */
  order: number;
  lineWidth: DataDrivenPropertyValueSpecification<number>;
  iconSize: DataDrivenPropertyValueSpecification<number>;
}

/**
 * One GeoJSON source drawn as severity-coloured lines plus glyph markers. The
 * features are published through the GeoJSON data bridge, so the descriptor
 * itself only ever carries the shared empty collection.
 */
export function incidentLayerGroup(
  ids: IncidentLayerIds,
  { zoom, order, lineWidth, iconSize }: IncidentLayerOptions,
): MapLayerGroup {
  return {
    sources: { [ids.source]: { type: "geojson", data: EMPTY_FEATURE_COLLECTION } },
    layers: [
      {
        id: ids.line,
        type: "line",
        source: ids.source,
        filter: ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
        ...zoom,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": SEVERITY_LINE_COLOR,
          "line-width": lineWidth,
          "line-opacity": ROAD_CONDITION_LINE_OPACITY,
          "line-dasharray": ROAD_CONDITION_LINE_DASHARRAY,
        },
        slot: "conditions-lines",
        order,
      },
      {
        id: ids.marker,
        type: "symbol",
        source: ids.source,
        filter: ["==", ["geometry-type"], "Point"],
        ...zoom,
        layout: {
          "icon-image": ["get", "_icon"],
          "icon-size": iconSize,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          // Higher sort-key is drawn last (on top), so key by severity rank
          // — the worst condition's disc sits on top where markers overlap.
          "symbol-sort-key": ["get", "_sev"],
        },
        paint: {
          "icon-opacity": ROAD_CONDITION_MARKER_OPACITY,
        },
        slot: "overlay-markers",
        order,
      },
    ],
  };
}

/**
 * Collect every marker near the click — not just the top one — so several
 * conditions stacked at the same spot all stay reachable in a single popup
 * (linked works often share a segment: roadworks + its lane closure land on
 * the same point). The radius is ~one marker-width so touching/overlapping
 * discs are grouped while genuinely separate incidents stay independent. A
 * line click keeps the arbiter's own hits.
 */
export function incidentClickHits(
  map: maplibregl.Map,
  markerLayerId: string,
  { event, features }: MapOverlayInteractionEvent,
): MapGeoJSONFeature[] {
  const markerFeatures = features.filter((feature) => feature.layer?.id === markerLayerId);
  if (markerFeatures.length === 0) return features;
  const r = 24;
  const box: [[number, number], [number, number]] = [
    [event.point.x - r, event.point.y - r],
    [event.point.x + r, event.point.y + r],
  ];
  const queried = map.getLayer(markerLayerId)
    ? (map.queryRenderedFeatures(box, { layers: [markerLayerId] }) as MapGeoJSONFeature[])
    : [];
  return queried.length > 0 ? queried : markerFeatures;
}

/**
 * Open the incident popup as the map's one overlay popup. Returns false when
 * none of the hits has a current condition to show.
 */
export function openIncidentPopup(
  map: maplibregl.Map,
  popupRef: RefObject<maplibregl.Popup | null>,
  input: RoadConditionPopupInput,
): boolean {
  const content = buildRoadConditionPopupHtml(input);
  if (content.groupCount === 0) return false;
  const popup = new maplibregl.Popup({
    closeButton: true,
    maxWidth: "300px",
    className: "omx-popup",
  })
    .setLngLat(content.coordinates)
    .setHTML(content.html);
  popupRef.current = popup;
  replaceMapOverlayPopup(map, popup);
  return true;
}

export function closeIncidentPopup(
  map: maplibregl.Map,
  popupRef: RefObject<maplibregl.Popup | null>,
): void {
  if (!popupRef.current) return;
  removeMapOverlayPopup(map, popupRef.current);
  popupRef.current = null;
}
