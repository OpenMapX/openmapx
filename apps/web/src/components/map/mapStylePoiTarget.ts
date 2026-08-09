import type * as maplibregl from "maplibre-gl";
import type { MapGeoJSONFeature, StyleSpecification } from "maplibre-gl";

const POI_SOURCE_LAYERS = new Set(["poi"]);
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
      const sourceLayer = (layer as { "source-layer"?: string })["source-layer"];
      return sourceLayer !== undefined && POI_SOURCE_LAYERS.has(sourceLayer);
    })
    .map((layer) => layer.id);
}

function targetFromFeature(feature: MapGeoJSONFeature): StylePoiTarget | null {
  if (feature.geometry.type !== "Point") return null;
  const name = feature.properties?.name;
  const [lng, lat] = feature.geometry.coordinates;
  if (typeof name !== "string" || name.length === 0) return null;
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
    const target = targetFromFeature(feature);
    if (target) return target;
  }
  return null;
}
