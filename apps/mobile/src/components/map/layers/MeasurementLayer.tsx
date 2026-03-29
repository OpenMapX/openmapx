import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import type { LngLat } from "@openmapx/core";
import { formatArea, formatMeasurementDistance, useMeasurementStore } from "@openmapx/core";
import { area } from "@turf/area";
import { lineString, polygon as turfPolygon } from "@turf/helpers";
import { length } from "@turf/length";
import { useMemo } from "react";

const PRIMARY_BLUE = "#1A73E8";

function midpoint(a: LngLat, b: LngLat): LngLat {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function segmentDistance(a: LngLat, b: LngLat): number {
  return length(lineString([a, b]), { units: "meters" });
}

function totalLineLength(points: LngLat[]): number {
  if (points.length < 2) return 0;
  return length(lineString(points), { units: "meters" });
}

function polygonArea(points: LngLat[]): number {
  if (points.length < 3) return 0;
  const ring = [...points, points[0]];
  return area(turfPolygon([ring]));
}

function centroid(points: LngLat[]): LngLat {
  const sumLng = points.reduce((s, p) => s + p[0], 0);
  const sumLat = points.reduce((s, p) => s + p[1], 0);
  return [sumLng / points.length, sumLat / points.length];
}

interface GeoJSONData {
  mainGeoJSON: GeoJSON.FeatureCollection;
  labelsGeoJSON: GeoJSON.FeatureCollection;
}

function buildGeoJSON(
  points: LngLat[],
  mode: "line" | "polygon",
  unitSystem: "metric" | "imperial",
  isFinalized: boolean,
): GeoJSONData {
  const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

  if (points.length === 0) {
    return { mainGeoJSON: empty, labelsGeoJSON: empty };
  }

  const mainFeatures: GeoJSON.Feature[] = [];
  const labelFeatures: GeoJSON.Feature[] = [];

  // Vertices
  for (let i = 0; i < points.length; i++) {
    mainFeatures.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: points[i] },
      properties: { kind: "vertex", index: i, isFirst: i === 0 },
    });
  }

  if (points.length < 2) {
    return {
      mainGeoJSON: { type: "FeatureCollection", features: mainFeatures },
      labelsGeoJSON: empty,
    };
  }

  // Line geometry
  if (mode === "line") {
    mainFeatures.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: points },
      properties: { kind: "line" },
    });
  }

  // Polygon geometry
  if (mode === "polygon" && points.length >= 3) {
    const ring = [...points, points[0]];
    mainFeatures.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: { kind: "polygon" },
    });
    mainFeatures.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: ring },
      properties: { kind: "line" },
    });
  } else if (mode === "polygon" && points.length === 2) {
    mainFeatures.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: points },
      properties: { kind: "line" },
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
    labelFeatures.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: mid },
      properties: { label: formatMeasurementDistance(dist, unitSystem), labelType: "segment" },
    });
  }

  // Total / area label
  if (mode === "line" && points.length >= 2) {
    const total = totalLineLength(points);
    const lastPoint = points[points.length - 1];
    labelFeatures.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: lastPoint },
      properties: {
        label: formatMeasurementDistance(total, unitSystem),
        labelType: "total",
      },
    });
  } else if (mode === "polygon" && points.length >= 3 && isFinalized) {
    const a = polygonArea(points);
    const c = centroid(points);
    labelFeatures.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: c },
      properties: { label: formatArea(a, unitSystem), labelType: "area" },
    });
  }

  return {
    mainGeoJSON: { type: "FeatureCollection", features: mainFeatures },
    labelsGeoJSON: { type: "FeatureCollection", features: labelFeatures },
  };
}

export function MeasurementLayer() {
  const isActive = useMeasurementStore((s) => s.isActive);
  const mode = useMeasurementStore((s) => s.mode);
  const points = useMeasurementStore((s) => s.points);
  const unitSystem = useMeasurementStore((s) => s.unitSystem);
  const isFinalized = useMeasurementStore((s) => s.isFinalized);

  const { mainGeoJSON, labelsGeoJSON } = useMemo(
    () => buildGeoJSON(points, mode, unitSystem, isFinalized),
    [points, mode, unitSystem, isFinalized],
  );

  if (!isActive) return null;

  return (
    <>
      <GeoJSONSource id="measurement-source" data={mainGeoJSON}>
        {/* Polygon fill */}
        <Layer
          type="fill"
          id="measurement-polygon-fill"
          source="measurement-source"
          filter={["==", ["get", "kind"], "polygon"]}
          paint={{ "fill-color": PRIMARY_BLUE, "fill-opacity": 0.1 }}
        />
        {/* Line casing */}
        <Layer
          type="line"
          id="measurement-line-casing"
          source="measurement-source"
          filter={["==", ["get", "kind"], "line"]}
          paint={{ "line-color": "#FFFFFF", "line-width": 6, "line-opacity": 1 }}
          layout={{ "line-cap": "round", "line-join": "round" }}
        />
        {/* Line */}
        <Layer
          type="line"
          id="measurement-line"
          source="measurement-source"
          filter={["==", ["get", "kind"], "line"]}
          paint={{ "line-color": PRIMARY_BLUE, "line-width": 3 }}
          layout={{ "line-cap": "round", "line-join": "round" }}
        />
        {/* Vertices */}
        <Layer
          type="circle"
          id="measurement-vertices"
          source="measurement-source"
          filter={["==", ["get", "kind"], "vertex"]}
          paint={{
            "circle-radius": ["case", ["==", ["get", "isFirst"], true], 6, 5],
            "circle-color": "#FFFFFF",
            "circle-stroke-color": PRIMARY_BLUE,
            "circle-stroke-width": 2,
          }}
        />
      </GeoJSONSource>
      <GeoJSONSource id="measurement-labels-source" data={labelsGeoJSON}>
        {/* Segment and total labels */}
        <Layer
          type="symbol"
          id="measurement-labels"
          source="measurement-labels-source"
          layout={{
            "text-field": ["get", "label"],
            "text-size": [
              "case",
              ["any", ["==", ["get", "labelType"], "total"], ["==", ["get", "labelType"], "area"]],
              14,
              12,
            ],
            "text-offset": [0, -1.2],
            "text-allow-overlap": true,
            "text-ignore-placement": true,
          }}
          paint={{
            "text-color": PRIMARY_BLUE,
            "text-halo-color": "#FFFFFF",
            "text-halo-width": 2,
          }}
        />
      </GeoJSONSource>
    </>
  );
}
