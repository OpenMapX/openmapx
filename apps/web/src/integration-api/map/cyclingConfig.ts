export const CYCLING_MIN_ZOOM = 10;

export const CYCLING_SOURCE_LAYER = "transportation";
export const CYCLING_POI_SOURCE_LAYER = "poi";

export const CYCLING_LAYER_IDS = {
  tracks: "openmapx-cycling-tracks",
  lanes: "openmapx-cycling-lanes",
  designated: "openmapx-cycling-designated",
  permitted: "openmapx-cycling-permitted",
  parking: "openmapx-cycling-parking",
  shops: "openmapx-cycling-shops",
  labels: "openmapx-cycling-labels",
} as const;

export const CYCLING_COLORS = {
  track: "#0D7C3D",
  lane: "#2E8B57",
  designated: "#4A90D9",
  permitted: "#7CB342",
  parking: "#1565C0",
  shop: "#6A1B9A",
  repair: "#E65100",
  rental: "#00838F",
} as const;
