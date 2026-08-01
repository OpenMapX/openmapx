"use client";

import type { LngLat } from "@openmapx/core";
import { formatArea, formatMeasurementDistance } from "@openmapx/core";
import { area } from "@turf/area";
import { lineString, polygon as turfPolygon } from "@turf/helpers";
import { length } from "@turf/length";
import type { MapMouseEvent } from "maplibre-gl";
import { useCallback, useEffect, useRef } from "react";
import { addLayerInSlot, unregisterLayerSlot } from "@/components/map/layers/layerStack";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { useMap } from "@/lib/MapContext";
import { useMeasurementStore } from "./store";

const SOURCE_ID = "measurement-source";
const LINE_CASING_LAYER = "measurement-line-casing";
const LINE_LAYER = "measurement-line";
const POLYGON_FILL_LAYER = "measurement-polygon-fill";
const POLYGON_OUTLINE_LAYER = "measurement-polygon-outline";
const VERTICES_LAYER = "measurement-vertices";
const LABELS_LAYER = "measurement-labels";
const RUBBERBAND_SOURCE = "measurement-rubberband-source";
const RUBBERBAND_LAYER = "measurement-rubberband";

const PRIMARY_BLUE = "#1A73E8";

const LAYER_IDS = [
  VERTICES_LAYER,
  LABELS_LAYER,
  LINE_LAYER,
  LINE_CASING_LAYER,
  POLYGON_FILL_LAYER,
  POLYGON_OUTLINE_LAYER,
];

function midpoint(a: LngLat, b: LngLat): LngLat {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function segmentDistance(a: LngLat, b: LngLat): number {
  const line = lineString([a, b]);
  return length(line, { units: "meters" });
}

function totalLineLength(points: LngLat[]): number {
  if (points.length < 2) return 0;
  const line = lineString(points);
  return length(line, { units: "meters" });
}

function polygonArea(points: LngLat[]): number {
  if (points.length < 3) return 0;
  const ring = [...points, points[0]];
  const poly = turfPolygon([ring]);
  return area(poly);
}

function centroid(points: LngLat[]): LngLat {
  const sumLng = points.reduce((s, p) => s + p[0], 0);
  const sumLat = points.reduce((s, p) => s + p[1], 0);
  return [sumLng / points.length, sumLat / points.length];
}

interface GeoJSONData {
  lineGeoJSON: GeoJSON.FeatureCollection;
  polygonGeoJSON: GeoJSON.FeatureCollection;
  verticesGeoJSON: GeoJSON.FeatureCollection;
  labelsGeoJSON: GeoJSON.FeatureCollection;
}

function buildGeoJSON(
  points: LngLat[],
  mode: "line" | "polygon",
  unitSystem: "metric" | "imperial",
  isFinalized: boolean,
): GeoJSONData {
  const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  const lineGeoJSON: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  const polygonGeoJSON: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  const labelsGeoJSON: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

  if (points.length === 0)
    return {
      lineGeoJSON: empty,
      polygonGeoJSON: empty,
      verticesGeoJSON: empty,
      labelsGeoJSON: empty,
    };

  // Vertices
  const vertexFeatures: GeoJSON.Feature[] = points.map((p, i) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: p },
    properties: { index: i, isFirst: i === 0 },
  }));
  const verticesGeoJSON: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: vertexFeatures,
  };

  if (points.length < 2)
    return { lineGeoJSON: empty, polygonGeoJSON: empty, verticesGeoJSON, labelsGeoJSON: empty };

  // Line
  if (mode === "line") {
    lineGeoJSON.features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: points },
      properties: {},
    });
  }

  // Polygon
  if (mode === "polygon" && points.length >= 3) {
    const ring = [...points, points[0]];
    polygonGeoJSON.features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: {},
    });
    // Also draw the outline as a line (including closing segment)
    lineGeoJSON.features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: ring },
      properties: {},
    });
  } else if (mode === "polygon" && points.length === 2) {
    // Just draw a line between the two points
    lineGeoJSON.features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: points },
      properties: {},
    });
  }

  // Segment labels
  const segmentPoints =
    mode === "polygon" && points.length >= 3 && isFinalized ? [...points, points[0]] : points;

  for (let i = 0; i < segmentPoints.length - 1; i++) {
    const a = segmentPoints[i];
    const b = segmentPoints[i + 1];
    const dist = segmentDistance(a, b);
    const mid = midpoint(a, b);
    labelsGeoJSON.features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: mid },
      properties: { label: formatMeasurementDistance(dist, unitSystem), type: "segment" },
    });
  }

  // Total / area label
  if (mode === "line" && points.length >= 2) {
    const total = totalLineLength(points);
    const lastPoint = points[points.length - 1];
    labelsGeoJSON.features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: lastPoint },
      properties: {
        label: formatMeasurementDistance(total, unitSystem),
        type: "total",
      },
    });
  } else if (mode === "polygon" && points.length >= 3 && isFinalized) {
    const a = polygonArea(points);
    const c = centroid(points);
    labelsGeoJSON.features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: c },
      properties: { label: formatArea(a, unitSystem), type: "area" },
    });
  }

  return { lineGeoJSON, polygonGeoJSON, verticesGeoJSON, labelsGeoJSON };
}

export function MeasurementLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const isActive = useMeasurementStore((s) => s.isActive);
  const mode = useMeasurementStore((s) => s.mode);
  const points = useMeasurementStore((s) => s.points);
  const unitSystem = useMeasurementStore((s) => s.unitSystem);
  const isFinalized = useMeasurementStore((s) => s.isFinalized);

  const draggingRef = useRef<number | null>(null);
  const mousePositionRef = useRef<LngLat | null>(null);

  // Register/unregister interactive layer IDs
  useEffect(() => {
    if (!isActive) return;
    for (const id of LAYER_IDS) INTERACTIVE_LAYER_IDS.add(id);
    return () => {
      for (const id of LAYER_IDS) INTERACTIVE_LAYER_IDS.delete(id);
    };
  }, [isActive]);

  // Set up sources and layers
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !isActive) return;

    const setup = () => {
      if (map.getSource(SOURCE_ID)) return;

      const emptyFC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

      map.addSource(SOURCE_ID, { type: "geojson", data: emptyFC });
      map.addSource(RUBBERBAND_SOURCE, { type: "geojson", data: emptyFC });

      // `route-markers`, not an overlay band: the ruler is the user's active
      // in-progress edit, drawn above the base labels exactly like the route's
      // own waypoint pins, so vertices and distance labels stay legible over
      // any road/place text underneath.
      // Polygon fill
      addLayerInSlot(
        map,
        {
          id: POLYGON_FILL_LAYER,
          type: "fill",
          source: SOURCE_ID,
          filter: ["==", "$type", "Polygon"],
          paint: { "fill-color": PRIMARY_BLUE, "fill-opacity": 0.1 },
        },
        "route-markers",
        10,
      );

      // Line casing (white outline for contrast)
      addLayerInSlot(
        map,
        {
          id: LINE_CASING_LAYER,
          type: "line",
          source: SOURCE_ID,
          filter: ["==", "$type", "LineString"],
          paint: { "line-color": "#FFFFFF", "line-width": 6, "line-opacity": 1 },
          layout: { "line-cap": "round", "line-join": "round" },
        },
        "route-markers",
        11,
      );

      // Line
      addLayerInSlot(
        map,
        {
          id: LINE_LAYER,
          type: "line",
          source: SOURCE_ID,
          filter: ["==", "$type", "LineString"],
          paint: { "line-color": PRIMARY_BLUE, "line-width": 3 },
          layout: { "line-cap": "round", "line-join": "round" },
        },
        "route-markers",
        12,
      );

      // Polygon outline (on top of line)
      addLayerInSlot(
        map,
        {
          id: POLYGON_OUTLINE_LAYER,
          type: "line",
          source: SOURCE_ID,
          filter: ["==", "$type", "Polygon"],
          paint: { "line-color": PRIMARY_BLUE, "line-width": 3 },
          layout: { "line-cap": "round", "line-join": "round" },
        },
        "route-markers",
        13,
      );

      // Rubber band
      addLayerInSlot(
        map,
        {
          id: RUBBERBAND_LAYER,
          type: "line",
          source: RUBBERBAND_SOURCE,
          paint: {
            "line-color": PRIMARY_BLUE,
            "line-width": 2,
            "line-dasharray": [4, 4],
            "line-opacity": 0.6,
          },
          layout: { "line-cap": "round" },
        },
        "route-markers",
        14,
      );

      // Vertices
      addLayerInSlot(
        map,
        {
          id: VERTICES_LAYER,
          type: "circle",
          source: SOURCE_ID,
          filter: ["==", "$type", "Point"],
          paint: {
            "circle-radius": [
              "case",
              ["==", ["get", "type"], "segment"],
              0,
              ["==", ["get", "type"], "total"],
              0,
              ["==", ["get", "type"], "area"],
              0,
              ["==", ["get", "isFirst"], true],
              6,
              5,
            ],
            "circle-color": "#FFFFFF",
            "circle-stroke-color": PRIMARY_BLUE,
            "circle-stroke-width": 2,
          },
        },
        "route-markers",
        15,
      );

      // Labels
      addLayerInSlot(
        map,
        {
          id: LABELS_LAYER,
          type: "symbol",
          source: SOURCE_ID,
          filter: ["has", "label"],
          layout: {
            "text-field": ["get", "label"],
            "text-size": [
              "case",
              ["any", ["==", ["get", "type"], "total"], ["==", ["get", "type"], "area"]],
              14,
              12,
            ],
            "text-font": ["Noto Sans Bold"],
            "text-offset": [0, -1.2],
            "text-allow-overlap": true,
            "text-ignore-placement": true,
          },
          paint: {
            "text-color": PRIMARY_BLUE,
            "text-halo-color": "#FFFFFF",
            "text-halo-width": 2,
          },
        },
        "route-markers",
        16,
      );
    };

    if (map.isStyleLoaded()) {
      setup();
    } else {
      map.once("styledata", setup);
    }

    return () => {
      if (!map.getStyle()) return;
      for (const id of [
        LABELS_LAYER,
        VERTICES_LAYER,
        RUBBERBAND_LAYER,
        POLYGON_OUTLINE_LAYER,
        LINE_LAYER,
        LINE_CASING_LAYER,
        POLYGON_FILL_LAYER,
      ]) {
        if (map.getLayer(id)) map.removeLayer(id);
        unregisterLayerSlot(id);
      }
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      if (map.getSource(RUBBERBAND_SOURCE)) map.removeSource(RUBBERBAND_SOURCE);
    };
  }, [mapRef, mapReady, styleVersion, isActive]);

  // Update GeoJSON data when points/mode/units change
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !isActive) return;

    const src = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    const { lineGeoJSON, polygonGeoJSON, verticesGeoJSON, labelsGeoJSON } = buildGeoJSON(
      points,
      mode,
      unitSystem,
      isFinalized,
    );

    // Merge all features into the single source
    const allFeatures: GeoJSON.Feature[] = [
      ...polygonGeoJSON.features,
      ...lineGeoJSON.features,
      ...verticesGeoJSON.features,
      ...labelsGeoJSON.features,
    ];

    src.setData({ type: "FeatureCollection", features: allFeatures });
  }, [mapRef, mapReady, styleVersion, isActive, points, mode, unitSystem, isFinalized]);

  // Rubber band line following cursor
  const updateRubberBand = useCallback(
    (cursorPos: LngLat | null) => {
      const map = mapRef.current;
      if (!map) return;
      const src = map.getSource(RUBBERBAND_SOURCE) as maplibregl.GeoJSONSource | undefined;
      if (!src) return;

      const { points: pts, isFinalized: fin, mode: m } = useMeasurementStore.getState();
      if (!cursorPos || pts.length === 0 || fin) {
        src.setData({ type: "FeatureCollection", features: [] });
        return;
      }

      const lastPt = pts[pts.length - 1];
      const features: GeoJSON.Feature[] = [
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [lastPt, cursorPos] },
          properties: {},
        },
      ];

      // In polygon mode with >=2 points, also show closing line from cursor to first point
      if (m === "polygon" && pts.length >= 2) {
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: [cursorPos, pts[0]] },
          properties: {},
        });
      }

      src.setData({ type: "FeatureCollection", features });
    },
    [mapRef],
  );

  // Map click handler for adding points
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !isActive) return;

    const onClick = (e: MapMouseEvent) => {
      const state = useMeasurementStore.getState();
      if (state.isFinalized) return;

      // Check if clicking on an existing vertex
      const vertexFeatures = map.queryRenderedFeatures(e.point, { layers: [VERTICES_LAYER] });
      const clickedVertex = vertexFeatures.find(
        (f) => f.properties?.index !== undefined && f.properties?.type === undefined,
      );

      if (clickedVertex) {
        const idx = clickedVertex.properties?.index as number;
        // Clicking first vertex in polygon mode with >=3 points closes the polygon
        if (state.mode === "polygon" && idx === 0 && state.points.length >= 3) {
          useMeasurementStore.getState().finalize();
          return;
        }
        // Otherwise remove the vertex
        useMeasurementStore.getState().removePoint(idx);
        return;
      }

      const lngLat: LngLat = [e.lngLat.lng, e.lngLat.lat];
      useMeasurementStore.getState().addPoint(lngLat);
    };

    const onDblClick = (e: MapMouseEvent) => {
      e.preventDefault();
      const state = useMeasurementStore.getState();
      if (state.points.length >= 2) {
        state.finalize();
      }
    };

    map.on("click", onClick);
    map.on("dblclick", onDblClick);
    return () => {
      map.off("click", onClick);
      map.off("dblclick", onDblClick);
    };
  }, [mapRef, mapReady, styleVersion, isActive]);

  // Mousemove handler for rubber band + cursor
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !isActive) return;

    const onMouseMove = (e: MapMouseEvent) => {
      const pos: LngLat = [e.lngLat.lng, e.lngLat.lat];
      mousePositionRef.current = pos;

      if (draggingRef.current !== null) return;

      updateRubberBand(pos);

      // Cursor
      const vertexFeatures = map.queryRenderedFeatures(e.point, { layers: [VERTICES_LAYER] });
      const onVertex = vertexFeatures.some(
        (f) => f.properties?.index !== undefined && f.properties?.type === undefined,
      );
      map.getCanvas().style.cursor = onVertex ? "pointer" : "crosshair";
    };

    map.on("mousemove", onMouseMove);
    return () => {
      map.off("mousemove", onMouseMove);
      map.getCanvas().style.cursor = "";
    };
  }, [mapRef, mapReady, styleVersion, isActive, updateRubberBand]);

  // Vertex dragging
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !isActive) return;

    let dragIndex: number | null = null;

    const onMouseDown = (e: MapMouseEvent) => {
      const features = map.queryRenderedFeatures(e.point, { layers: [VERTICES_LAYER] });
      const vertex = features.find(
        (f) => f.properties?.index !== undefined && f.properties?.type === undefined,
      );
      if (!vertex) return;

      dragIndex = vertex.properties?.index as number;
      draggingRef.current = dragIndex;
      map.getCanvas().style.cursor = "grabbing";

      // Prevent map panning
      map.dragPan.disable();
      e.preventDefault();
    };

    const onMouseMoveForDrag = (e: MapMouseEvent) => {
      if (dragIndex === null) return;
      const lngLat: LngLat = [e.lngLat.lng, e.lngLat.lat];
      useMeasurementStore.getState().movePoint(dragIndex, lngLat);
    };

    const onMouseUp = () => {
      if (dragIndex === null) return;
      dragIndex = null;
      draggingRef.current = null;
      map.getCanvas().style.cursor = "crosshair";
      map.dragPan.enable();
    };

    map.on("mousedown", onMouseDown);
    map.on("mousemove", onMouseMoveForDrag);
    map.on("mouseup", onMouseUp);

    return () => {
      map.off("mousedown", onMouseDown);
      map.off("mousemove", onMouseMoveForDrag);
      map.off("mouseup", onMouseUp);
      if (dragIndex !== null) {
        map.dragPan.enable();
      }
    };
  }, [mapRef, mapReady, styleVersion, isActive]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!isActive) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        return;

      const state = useMeasurementStore.getState();
      const isMod = e.metaKey || e.ctrlKey;

      if (e.key === "Escape") {
        e.preventDefault();
        if (state.points.length > 0) {
          state.clear();
        } else {
          state.deactivate();
        }
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        state.finalize();
        return;
      }

      if (e.key === "z" && isMod && e.shiftKey) {
        e.preventDefault();
        state.redo();
        return;
      }

      if (e.key === "z" && isMod) {
        e.preventDefault();
        state.undo();
        return;
      }

      if (e.key === "l" || e.key === "L") {
        state.setMode("line");
        return;
      }

      if (e.key === "p" || e.key === "P") {
        state.setMode("polygon");
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isActive]);

  // Cursor reset on deactivate
  useEffect(() => {
    if (isActive) return;
    const map = mapRef.current;
    if (map) {
      map.getCanvas().style.cursor = "";
      // Clear rubber band
      const src = map.getSource(RUBBERBAND_SOURCE) as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData({ type: "FeatureCollection", features: [] });
    }
  }, [isActive, mapRef]);

  // Suppress double-tap zoom on mobile while active
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (isActive) {
      map.doubleClickZoom.disable();
    } else {
      map.doubleClickZoom.enable();
    }
    return () => {
      map.doubleClickZoom.enable();
    };
  }, [mapRef, mapReady, styleVersion, isActive]);

  return null;
}
