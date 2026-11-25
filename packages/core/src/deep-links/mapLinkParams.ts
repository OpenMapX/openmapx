/**
 * Query parameters of a shareable map URL (`/?…`), the format people bookmark
 * and paste. Every name is a full lowerCamel word; every boolean is written
 * `1` or `0`. Unknown parameters are ignored, so the set can grow without a
 * version, but a name here never changes meaning.
 *
 * The web app's parser and writer (`apps/web/src/lib/deepLink.ts`) and every
 * other place that builds these URLs, the native app included, use these
 * constants.
 */
export const MAP_LINK_PARAMS = {
  /** Camera: `lat,lng,zoom[,bearing[,pitch]]`. */
  camera: "map",
  baseLayer: "baseLayer",
  globe: "globe",
  buildings: "buildings",
  /** Comma-separated overlay ids. */
  overlay: "overlay",
  panel: "panel",

  /** A place's primary id; needs {@link MAP_LINK_PARAMS.placeLocation}. */
  place: "place",
  /** The place's coordinates: `lat,lng`. */
  placeLocation: "placeLocation",
  placeName: "placeName",
  /** The place's display category. */
  placeCategory: "placeCategory",
  /** The place's source category tag, such as `amenity/cafe`. */
  placeRawCategory: "placeRawCategory",
  /** Name of the transit stop the place was opened for. */
  placeTransitStop: "placeTransitStop",

  travelMode: "mode",
  bikeProfile: "bikeProfile",
  bikeHillPreference: "bikeHillPreference",
  bikePreferQuietRoads: "bikePreferQuietRoads",
  bikePreferSmoothSurfaces: "bikePreferSmoothSurfaces",
  bikeSpeedKmh: "bikeSpeedKmh",
  /** Comma-separated: `highways`, `tolls`, `ferries`. */
  avoid: "avoid",
  /** Repeated, one per directions slot: `lat,lng[,label]`, empty for a blank slot. */
  waypoint: "waypoint",
  /** Versioned per-waypoint time constraints. */
  schedule: "schedule",

  /** The id of a category search (the results list a category chip opens). */
  category: "category",
  /** The text of an area search. */
  search: "search",
  /** `west,south,east,north`. */
  bounds: "bounds",
  dataSource: "dataSource",
  dataSourceItem: "dataSourceItem",
  savedTab: "savedTab",
  savedList: "savedList",

  measurement: "measurement",
  measurementUnits: "measurementUnits",
  /** `lat,lng;lat,lng;…`. */
  measurementPoints: "measurementPoints",
  measurementFinished: "measurementFinished",
  travelTime: "travelTime",
  travelTimeOrigin: "travelTimeOrigin",
  travelTimeMinutes: "travelTimeMinutes",

  weather: "weather",
  satelliteLayer: "satelliteLayer",
  satelliteDate: "satelliteDate",
  satelliteOpacity: "satelliteOpacity",
  /** `timeRange,minMagnitude,colorMode,heatmap(1|0)`. */
  earthquakes: "earthquakes",
  /** `dayRange,source,heatmap(1|0)`. */
  wildfires: "wildfires",
  naturalEventDays: "naturalEventDays",
  naturalEventCategories: "naturalEventCategories",
  weatherAlertSeverities: "weatherAlertSeverities",
  environmentSensor: "environmentSensor",
  streetLevelImage: "streetLevelImage",
  hikingTrail: "hikingTrail",
  winterSportsFeature: "winterSportsFeature",
  cyclingAutomatic: "cyclingAutomatic",
  liveTransitExcludedProviders: "liveTransitExcludedProviders",
  liveTransitExcludedModes: "liveTransitExcludedModes",
  liveTransitExcludedCodespaces: "liveTransitExcludedCodespaces",
  liveTransitVehicle: "liveTransitVehicle",
} as const;

export type MapLinkParam = (typeof MAP_LINK_PARAMS)[keyof typeof MAP_LINK_PARAMS];

/**
 * One-shot intents the app consumes and removes from the address bar: a text
 * search handed over by the share target or a native map intent, a `geo:` URI
 * from a protocol handler, a home-screen shortcut action, and the return from
 * an OpenStreetMap sign-in to the contribution it was for.
 */
export const MAP_INTENT_PARAMS = {
  query: "query",
  geo: "geo",
  action: "action",
  osmContribution: "osmContribution",
} as const;

/** How a boolean is written in a map URL. */
export function formatLinkBoolean(value: boolean): "1" | "0" {
  return value ? "1" : "0";
}

/** `1` is true and `0` false; anything else, or no value, is unset. */
export function parseLinkBoolean(value: string | null): boolean | undefined {
  if (value === "1") return true;
  if (value === "0") return false;
  return undefined;
}
