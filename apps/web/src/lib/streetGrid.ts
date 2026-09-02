import {
  bearingDelta,
  dominantGridBearing,
  nearestGridBearing,
  type WeightedBearing,
} from "@openmapx/core";
import { bearingBetween } from "@openmapx/core/navigation";
import type * as maplibregl from "maplibre-gl";

export const ALIGN_MIN_ZOOM = 13;
/** Weighted road pixels the sample must contain before a grid is trusted. */
export const ALIGN_MIN_WEIGHT_PX = 800;
export const ALIGN_MIN_CONFIDENCE = 0.6;
export const ALIGN_DEAD_BAND_DEG = 2;

const SAMPLE_FRACTION = 0.7;
const MAX_FEATURES = 2000;
const MAX_VERTICES = 20_000;

/** Road classes that form grids, weighted; motorways curve and rarely follow the local grid. */
const CLASS_WEIGHT: Record<string, number> = {
  minor: 1,
  tertiary: 1,
  secondary: 0.9,
  primary: 0.8,
  trunk: 0.4,
  motorway: 0.3,
};

export type StreetGridAlignment =
  | { status: "zoomed-out" }
  | { status: "no-grid" }
  | { status: "aligned" }
  | { status: "ok"; bearing: number };

/** Line layers drawn from the OpenMapTiles `transportation` source-layer, whatever the style names them. */
export function roadLineLayerIds(map: maplibregl.Map): string[] {
  try {
    const layers = map.getStyle()?.layers ?? [];
    return layers
      .filter(
        (layer) =>
          layer.type === "line" &&
          (layer as { "source-layer"?: string })["source-layer"] === "transportation",
      )
      .map((layer) => layer.id);
  } catch {
    return [];
  }
}

/** The central part of the viewport that is not covered by chrome, in whole pixels. */
export function visibleSampleBox(map: maplibregl.Map): [[number, number], [number, number]] {
  const container = map.getContainer();
  const padding = map.getPadding();
  const x0 = padding.left ?? 0;
  const x1 = container.clientWidth - (padding.right ?? 0);
  const y0 = padding.top ?? 0;
  const y1 = container.clientHeight - (padding.bottom ?? 0);
  const inset = (1 - SAMPLE_FRACTION) / 2;
  const insetX = (x1 - x0) * inset;
  const insetY = (y1 - y0) * inset;
  return [
    [Math.round(x0 + insetX), Math.round(y0 + insetY)],
    [Math.round(x1 - insetX), Math.round(y1 - insetY)],
  ];
}

/**
 * One road reaches the query several times over: a style draws it as casing,
 * fill and a bridge or tunnel variant, each from its own layer but all from the
 * same source feature. Counting it once keeps the weight floor honest and
 * spends the feature budget on distinct roads instead of the bottom-most
 * layers. A feature without an id is nothing we can match, so it stays.
 */
function distinctFeatures(
  features: readonly maplibregl.MapGeoJSONFeature[],
): maplibregl.MapGeoJSONFeature[] {
  const seen = new Set<string | number>();
  const distinct: maplibregl.MapGeoJSONFeature[] = [];
  for (const feature of features) {
    if (feature.id !== undefined) {
      if (seen.has(feature.id)) continue;
      seen.add(feature.id);
    }
    distinct.push(feature);
    if (distinct.length === MAX_FEATURES) break;
  }
  return distinct;
}

export function sampleRoadSegments(map: maplibregl.Map): WeightedBearing[] {
  const layers = roadLineLayerIds(map);
  if (layers.length === 0) return [];
  let features: maplibregl.MapGeoJSONFeature[];
  try {
    features = map.queryRenderedFeatures(visibleSampleBox(map), { layers });
  } catch {
    return [];
  }
  const samples: WeightedBearing[] = [];
  let vertices = 0;
  for (const feature of distinctFeatures(features)) {
    const classWeight = CLASS_WEIGHT[String(feature.properties?.class)];
    if (!classWeight) continue;
    const geometry = feature.geometry;
    const lines =
      geometry.type === "LineString"
        ? [geometry.coordinates]
        : geometry.type === "MultiLineString"
          ? geometry.coordinates
          : [];
    for (const coordinates of lines) {
      for (let i = 1; i < coordinates.length; i += 1) {
        vertices += 1;
        if (vertices > MAX_VERTICES) return samples;
        const a: [number, number] = [coordinates[i - 1][0], coordinates[i - 1][1]];
        const b: [number, number] = [coordinates[i][0], coordinates[i][1]];
        const pa = map.project(a);
        const pb = map.project(b);
        const pixels = Math.hypot(pb.x - pa.x, pb.y - pa.y);
        if (pixels < 1) continue;
        samples.push({ bearing: bearingBetween(a, b), weight: classWeight * pixels });
      }
    }
  }
  return samples;
}

export function computeStreetGridAlignment(map: maplibregl.Map): StreetGridAlignment {
  if (map.getZoom() < ALIGN_MIN_ZOOM) return { status: "zoomed-out" };
  const grid = dominantGridBearing(sampleRoadSegments(map));
  if (!grid || grid.weight < ALIGN_MIN_WEIGHT_PX || grid.confidence < ALIGN_MIN_CONFIDENCE) {
    return { status: "no-grid" };
  }
  const current = map.getBearing();
  const bearing = nearestGridBearing(current, grid.bearing);
  if (Math.abs(bearingDelta(current, bearing)) < ALIGN_DEAD_BAND_DEG) return { status: "aligned" };
  return { status: "ok", bearing: Math.round(bearing * 10) / 10 };
}

/** Same camera, same style: same answer. */
export function alignmentCacheKey(map: maplibregl.Map, styleVersion: number): string {
  const center = map.getCenter();
  const zoom = Math.round(map.getZoom() * 4) / 4;
  const bearing = Math.round(map.getBearing() * 2) / 2;
  return `${styleVersion}:${zoom}:${center.lng.toFixed(4)}:${center.lat.toFixed(4)}:${bearing}`;
}
