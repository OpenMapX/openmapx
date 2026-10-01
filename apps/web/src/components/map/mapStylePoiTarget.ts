import { haversineDistance } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import type { FilterSpecification, MapGeoJSONFeature, StyleSpecification } from "maplibre-gl";
import { STOP_LABEL_LAYER_ID } from "./stopLabelPoints";

const POI_SOURCE_LAYERS = new Set(["poi"]);
// Basemap POIs the app re-publishes through the style's own GeoJSON sources.
const REPUBLISHED_POI_LAYER_IDS = new Set([STOP_LABEL_LAYER_ID]);
const OWN_STYLE_POI_LAYER_IDS = new Set([
  "category-results-layer",
  "category-results-labels",
  "mapillary-sequence-layer",
  "mapillary-photo-layer",
  "mapillary-pano-layer",
]);

type StyleLayer = StyleSpecification["layers"][number];

export interface StylePoiTarget {
  featureId: string;
  name: string;
  coordinates: [number, number];
  category?: string;
  rawCategory?: string;
}

export function getStylePoiLayerIds(map: maplibregl.Map): string[] {
  const layers = map.getStyle()?.layers;
  if (!layers) return [];
  return (layers as StyleLayer[])
    .filter((layer) => {
      if (layer.type !== "symbol" || OWN_STYLE_POI_LAYER_IDS.has(layer.id)) return false;
      if (REPUBLISHED_POI_LAYER_IDS.has(layer.id)) return true;
      const sourceLayer = (layer as { "source-layer"?: string })["source-layer"];
      return sourceLayer !== undefined && POI_SOURCE_LAYERS.has(sourceLayer);
    })
    .map((layer) => layer.id);
}

/**
 * The name a basemap POI label shows: the map localises every `name` label to
 * `name:<locale>` with the plain `name` as fallback, so the selected place's
 * pin and panel take the same name the map printed beside the icon.
 */
function displayedName(properties: MapGeoJSONFeature["properties"], locale?: string) {
  const localized = locale ? properties?.[`name:${locale}`] : undefined;
  if (typeof localized === "string" && localized.length > 0) return localized;
  const name = properties?.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

function targetFromFeature(feature: MapGeoJSONFeature, locale?: string): StylePoiTarget | null {
  if (feature.geometry.type !== "Point") return null;
  const name = displayedName(feature.properties, locale);
  const [lng, lat] = feature.geometry.coordinates;
  if (name === null) return null;
  if (typeof lng !== "number" || typeof lat !== "number") return null;
  const poiClass = feature.properties?.class;
  const poiSubclass = feature.properties?.subclass;
  const className = typeof poiClass === "string" ? poiClass : undefined;
  const subclassName = typeof poiSubclass === "string" ? poiSubclass : undefined;
  return {
    featureId: String(feature.id ?? `${lng.toFixed(5)}-${lat.toFixed(5)}`),
    name,
    coordinates: [lng, lat],
    category: subclassName ?? className,
    rawCategory:
      className && subclassName ? `${className}/${subclassName}` : (subclassName ?? className),
  };
}

export function findStylePoiAtPoint(
  map: maplibregl.Map,
  point: maplibregl.PointLike,
  poiLayerIds: readonly string[],
  interactiveLayerIds: ReadonlySet<string>,
  locale?: string,
): StylePoiTarget | null {
  const livePoiLayers = poiLayerIds.filter((id) => Boolean(map.getLayer(id)));
  if (livePoiLayers.length === 0) return null;
  const overlayLayers = [...interactiveLayerIds].filter(
    (id) => !livePoiLayers.includes(id) && Boolean(map.getLayer(id)),
  );
  if (
    overlayLayers.length > 0 &&
    map.queryRenderedFeatures(point, { layers: overlayLayers }).length > 0
  ) {
    return null;
  }
  const features = map.queryRenderedFeatures(point, { layers: livePoiLayers });
  for (const feature of features) {
    const target = targetFromFeature(feature, locale);
    if (target) return target;
  }
  return null;
}

/** How far a basemap POI may sit from the selected place's pin and still be the same place. */
const SAME_PLACE_RADIUS_M = 150;

function normalizeName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function featureNames(properties: MapGeoJSONFeature["properties"]): string[] {
  const names: string[] = [];
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (typeof value !== "string") continue;
    if (key === "name" || key.startsWith("name:") || key.startsWith("name_")) {
      names.push(normalizeName(value));
    }
  }
  return names;
}

/**
 * The basemap POI feature standing for a selected place, so its own icon and
 * label can step aside for the place's pin. A clicked POI carries its tile
 * feature id; a place picked any other way (search, category results, saved
 * lists) is matched to the nearest POI within a short walk that carries one
 * of its names in any language.
 */
export function findStylePoiFeatureId(
  map: maplibregl.Map,
  poiLayerIds: readonly string[],
  place: { coordinates: [number, number]; names: readonly string[]; stylePoiId?: string },
): number | null {
  if (place.stylePoiId && /^\d+$/.test(place.stylePoiId)) return Number(place.stylePoiId);
  const wanted = new Set(place.names.filter(Boolean).map(normalizeName));
  if (wanted.size === 0) return null;
  const layers = (map.getStyle()?.layers ?? []) as StyleLayer[];
  const sources = new Set<string>();
  for (const layer of layers) {
    if (!poiLayerIds.includes(layer.id) || !("source" in layer)) continue;
    const sourceLayer = (layer as { "source-layer"?: string })["source-layer"];
    if (sourceLayer) sources.add(`${layer.source}\u0000${sourceLayer}`);
  }
  let best: { id: number; distance: number } | null = null;
  for (const key of sources) {
    const [source, sourceLayer] = key.split("\u0000");
    for (const feature of map.querySourceFeatures(source, { sourceLayer })) {
      if (typeof feature.id !== "number" || feature.geometry.type !== "Point") continue;
      const [lng, lat] = feature.geometry.coordinates;
      const distance = haversineDistance(place.coordinates, [lng, lat]);
      if (distance > SAME_PLACE_RADIUS_M || (best && distance >= best.distance)) continue;
      if (featureNames(feature.properties).some((name) => wanted.has(name))) {
        best = { id: feature.id, distance };
      }
    }
  }
  return best?.id ?? null;
}

/**
 * Mirrors MapLibre's own filter classification: a layer filter is either the
 * deprecated legacy syntax or an expression, and the two cannot be mixed in
 * one filter. `neutral` nodes parse either way.
 */
function filterSyntax(filter: unknown): "legacy" | "expression" | "neutral" {
  if (typeof filter === "boolean") return "neutral";
  if (!Array.isArray(filter) || filter.length === 0) return "legacy";
  switch (filter[0]) {
    case "has":
      if (filter.length < 2 || filter[1] === "$id" || filter[1] === "$type") return "legacy";
      return filter.length === 2 ? "neutral" : "expression";
    case "in":
      return filter.length >= 3 && (typeof filter[1] !== "string" || Array.isArray(filter[2]))
        ? "expression"
        : "legacy";
    case "!in":
    case "!has":
    case "none":
      return "legacy";
    case "==":
    case "!=":
    case ">":
    case ">=":
    case "<":
    case "<=":
      return filter.length !== 3 || Array.isArray(filter[1]) || Array.isArray(filter[2])
        ? "expression"
        : "legacy";
    case "any":
    case "all": {
      let sawLegacy = false;
      for (const child of filter.slice(1)) {
        const syntax = filterSyntax(child);
        if (syntax === "expression") return "expression";
        if (syntax === "legacy") sawLegacy = true;
      }
      return sawLegacy ? "legacy" : "neutral";
    }
    default:
      return "expression";
  }
}

/**
 * `filter` narrowed to leave out one feature, written in the syntax the filter
 * already uses — basemap styles still ship legacy filters on some POI layers.
 */
export function filterWithoutFeature(
  filter: FilterSpecification | undefined | null,
  featureId: number,
): FilterSpecification {
  if (filter === undefined || filter === null) return ["!=", ["id"], featureId];
  if (filterSyntax(filter) === "legacy") {
    return ["all", filter, ["!=", "$id", featureId]] as FilterSpecification;
  }
  return ["all", filter, ["!=", ["id"], featureId]] as FilterSpecification;
}
