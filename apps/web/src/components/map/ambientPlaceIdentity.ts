import type { CategoryPlace } from "@openmapx/core";
import type { MapGeoJSONFeature, Map as MapLibreMap } from "maplibre-gl";

const identities = new WeakMap<MapLibreMap, globalThis.Map<string, CategoryPlace>>();
export function ambientBasemapKey(feature: MapGeoJSONFeature): string {
  const point = feature.geometry.type === "Point" ? feature.geometry.coordinates.join(",") : "";
  return `${feature.source}/${feature.sourceLayer}/${feature.id ?? point}`;
}
export function setAmbientIdentities(
  map: MapLibreMap,
  places: globalThis.Map<string, CategoryPlace>,
): void {
  identities.set(map, places);
}
export function getAmbientIdentity(
  map: MapLibreMap,
  feature: MapGeoJSONFeature,
): CategoryPlace | undefined {
  return identities.get(map)?.get(ambientBasemapKey(feature));
}
export function clearAmbientIdentities(map: MapLibreMap): void {
  identities.delete(map);
}
