/**
 * A shared mutable set of MapLibre layer IDs that have their own click
 * handlers. MapClickHandler reads this set on every click to avoid clearing
 * `selectedPlace` when one of these layers was the actual click target.
 *
 * Other components (e.g. MapStylePoiClickHandler, CategoryResultMarkers) add
 * layer IDs here when they mount and remove them when they unmount.
 */
export const INTERACTIVE_LAYER_IDS = new Set<string>([
  "category-results-layer",
  "mapillary-sequence-layer",
  "mapillary-photo-layer",
  "mapillary-pano-layer",
]);
