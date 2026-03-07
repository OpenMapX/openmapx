// Types

// API
export { ApiClient, apiClient } from "./api/client";
export { API_ENDPOINTS } from "./api/endpoints";
// Hooks (Phase 3+, require API gateway)
export { useActiveSidePanel } from "./hooks/useActiveSidePanel";
export { useAutocomplete } from "./hooks/useAutocomplete";
export { useDirections } from "./hooks/useDirections";
export { useGeocoding } from "./hooks/useGeocoding";
export { useNearbyPlaces } from "./hooks/useNearbyPlaces";
export { usePlaceDetails } from "./hooks/usePlaceDetails";
export { useReverseGeocoding } from "./hooks/useReverseGeocoding";
export type { DirectionsState } from "./stores/directionsStore";
export { useDirectionsStore } from "./stores/directionsStore";
export type { MapLayer } from "./stores/layerStore";
export { useLayerStore } from "./stores/layerStore";
// Stores
export { useMapStore } from "./stores/mapStore";
export { usePlaceStore } from "./stores/placeStore";
export { useSearchStore } from "./stores/searchStore";
export { useStreetViewStore } from "./stores/streetViewStore";
export type { DirectionsResult, Route, RouteStep, TravelMode } from "./types/directions";
export type { BoundingBox, LngLat } from "./types/geometry";
export type { Place, PlaceFact, PlacePhoto, PlaceReviewLink } from "./types/place";
export type { AutocompleteResult, ReverseGeocodingResult, SearchResult } from "./types/search";

// Utils
export { haversineDistance, lngLatToString, roundCoord } from "./utils/coordinates";
export { formatDistance, formatDuration } from "./utils/formatting";
export { boundingBoxFromPoints, isPointInBBox } from "./utils/geo";
export type { DaySchedule, OpeningHoursStatus } from "./utils/openingHours";
export { parseOpeningHours } from "./utils/openingHours";
export {
  parseCoordinateInput,
  parseDMSCoordinateInput,
} from "./utils/parseCoordinates";
export {
  computePlusCode,
  decodePlusCode,
  decodeShortPlusCode,
  detectShortPlusCodeCity,
  parsePlusCodeInput,
  plusCodeUrl,
  shortenPlusCode,
} from "./utils/plusCode";
