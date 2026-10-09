/** Canonical owned-basemap identity and the current category/reach selection for ambient overlays. */
export {
  ambientBasemapKey,
  clearAmbientIdentities,
  setAmbientIdentities,
} from "@/components/map/ambientPlaceIdentity";
export { ambientPlaceStyle } from "@/components/map/ambientPlaceStyle";
export { getStylePoiLayerIds } from "@/components/map/mapStylePoiTarget";
export { useExploreReachResults as useActivePlaceResults } from "@/lib/useExploreReachResults";
