// Platform

// API
export { ApiClient, type ApiClientConfig, apiClient, configureApiClient } from "./api/client";
export { API_ENDPOINTS } from "./api/endpoints";
// Auth
export type { Session, User } from "./auth/client";
export { type AuthConfig, authClient, initAuth } from "./auth/client";
export type { OAuthProviderMeta } from "./auth/oauth-providers";
export { oauthProviders } from "./auth/oauth-providers";
export { useSession } from "./auth/useSession";
// Constants
export type { ProviderAttribution } from "./constants/transit";
export {
  MODE_COLORS,
  providerAttribution,
  providerLabel,
  resolveProvider,
} from "./constants/transit";
// Hooks — Transit
export {
  useArrivals,
  useDepartures,
  useLinkedTransitAlerts,
  useLinkedTransitArrivals,
  useLinkedTransitDepartures,
  useLinkedTransitFacilities,
  useLinkedTransitRoutes,
  useLinkedTransitStops,
  useProviders,
  useRouteAlerts,
  useRouteLive,
  useRouteStops,
  useRoutesForStop,
  useStopAlerts,
  useStopFacilities,
  useStopPlatforms,
  useStopSearch,
  useStopsNearby,
  useStopTimetable,
  useTransitPlan,
  useTransitRoute,
  useTransitStops,
  useVehicleJourney,
  useVehiclePositions,
} from "./hooks/transit";
export {
  isTransitEligiblePlace,
  isTransitName,
  isTransitRawCategory,
} from "./hooks/transit/transitEligibility";
// Hooks — General
export { useActiveSidePanel } from "./hooks/useActiveSidePanel";
export { useAdaptiveDebounce } from "./hooks/useAdaptiveDebounce";
export { useAutocomplete } from "./hooks/useAutocomplete";
export { useCategorySearch } from "./hooks/useCategorySearch";
export { useDataSourceEnrichment } from "./hooks/useDataSourceEnrichment";
// Hooks — Data Sources
export {
  useDataSourceDetail,
  useDataSourceSearch,
  useDataSources,
} from "./hooks/useDataSources";
export { useDebounce, useDebouncedCallback } from "./hooks/useDebounce";
export { useDirections } from "./hooks/useDirections";
export { useElevation } from "./hooks/useElevation";
export { useFilteredCategoryResults } from "./hooks/useFilteredCategoryResults";
export { useGeocoding } from "./hooks/useGeocoding";
export {
  useHikingArea,
  useHikingDetail,
  useHikingGeometry,
  useHikingSearch,
  useHikingShelters,
} from "./hooks/useHikingTrails";
export { useIsochrone } from "./hooks/useIsochrone";
export { useLiveTrains } from "./hooks/useLiveTrains";
export { useMergedPlace } from "./hooks/useMergedPlace";
export { useNearbyPlaces } from "./hooks/useNearbyPlaces";
export { useOptimizeRoute } from "./hooks/useOptimizeRoute";
export { useOverlayExclusion } from "./hooks/useOverlayExclusion";
export { usePlaceDetails } from "./hooks/usePlaceDetails";
export { usePlacePhotos } from "./hooks/usePlacePhotos";
export { useReverseGeocoding } from "./hooks/useReverseGeocoding";
export {
  useCreateList,
  useDeleteLabel,
  useDeleteList,
  useIsSaved,
  useLabeledPlaces,
  useRemovePlace,
  useSavedListPlaces,
  useSavedLists,
  useSavePlace,
  useUpdateLabel,
  useUpdateList,
  useUpdatePlace,
} from "./hooks/useSavedPlaces";
export type { PanelId } from "./panels/ids";
export { PANEL } from "./panels/ids";
export { getPanel, getPanelsByLayer, PANEL_REGISTRY } from "./panels/registry";
// Panel system
export type { PanelDefinition, PanelLayer } from "./panels/types";
export { configureStorage, getStorage, type StorageAdapter } from "./platform";
// Stores
export { useAirQualityStore } from "./stores/airQualityStore";
export { useBuildingsStore } from "./stores/buildingsStore";
export { useCategorySearchStore } from "./stores/categorySearchStore";
// Overlay system
export type { OverlayStoreBase } from "./stores/createOverlayStore";
export { useCyclingStore } from "./stores/cyclingStore";
export { useDataSourceStore } from "./stores/dataSourceStore";
export type { DirectionsState } from "./stores/directionsStore";
export { useDirectionsStore } from "./stores/directionsStore";
export { useEarthquakeStore } from "./stores/earthquakeStore";
export { useHikingStore } from "./stores/hikingStore";
export type { MapLayer } from "./stores/layerStore";
export { useLayerStore } from "./stores/layerStore";
export { useLiveTrainsStore } from "./stores/liveTrainsStore";
export { useMapClickStore } from "./stores/mapClickStore";
export { useMapStore } from "./stores/mapStore";
export type { MeasurementMode, MeasurementState, UnitSystem } from "./stores/measurementStore";
export { useMeasurementStore } from "./stores/measurementStore";
export { useMenuStore } from "./stores/menuStore";
export type { OpeningHoursFilter } from "./stores/openingHoursStore";
export { useOpeningHoursStore } from "./stores/openingHoursStore";
export type { OverlayEntry, OverlayId } from "./stores/overlayRegistry";
export {
  closeExclusionPeers,
  getOverlayEntry,
  isOverlayActive,
  OVERLAY_REGISTRY,
  toggleOverlay,
} from "./stores/overlayRegistry";
export { usePlaceStore } from "./stores/placeStore";
export { useSavedPlacesStore } from "./stores/savedPlacesStore";
export { useSearchStore } from "./stores/searchStore";
export { useSidebarStore } from "./stores/sidebarStore";
export { useStreetViewStore } from "./stores/streetViewStore";
export { useTrafficStore } from "./stores/trafficStore";
export { useTransitStore } from "./stores/transitStore";
export type { TravelTimeState } from "./stores/travelTimeStore";
export { TRAVEL_TIME_PRESETS, useTravelTimeStore } from "./stores/travelTimeStore";
export { useWildfireStore } from "./stores/wildfireStore";
export { useWinterSportsStore } from "./stores/winterSportsStore";

// Types
export type { CategoryDefinition, CategoryId, CategoryPlace } from "./types/category";
export {
  CATEGORY_DEFINITIONS,
  categoryPlaceToPlace,
  HOURS_FILTER_CATEGORY_IDS,
} from "./types/category";
export type {
  DataSourceAttribution,
  DataSourceDetail,
  DataSourceDetailSection,
  DataSourceFilterDef,
  DataSourceMarkerStyle,
  DataSourceMeta,
  DataSourceResult,
} from "./types/dataSource";
export type {
  DirectionsResult,
  Route,
  RouteLeg,
  RouteStep,
  TravelMode,
  Waypoint,
} from "./types/directions";
export type {
  ElevationApiResponse,
  ElevationPoint,
  ElevationProfile,
  ElevationStats,
} from "./types/elevation";
export type { BoundingBox, LngLat } from "./types/geometry";
export type {
  HikingFeatureCollection,
  HikingTrailDetail,
  HikingTrailSummary,
  MountainShelter,
  SacGrade,
  SacScale,
  ShelterFeatureCollection,
} from "./types/hiking";
export { SAC_GRADES } from "./types/hiking";
export type {
  IsochroneContour,
  IsochroneGeometry,
  IsochroneMultiPolygon,
  IsochronePolygon,
  IsochroneResult,
  IsochroneTravelMode,
} from "./types/isochrone";
export type { Place, PlaceFact, PlacePhoto, PlaceReviewLink } from "./types/place";
export type { LabeledPlace, SavedList, SavedPlace } from "./types/saved";
export type { AutocompleteResult, ReverseGeocodingResult, SearchResult } from "./types/search";
export type {
  AlertSeverity,
  Departure,
  Facility,
  FareProduct,
  MergedDeparture,
  MergedRoute,
  OccupancyLevel,
  RouteLive,
  RouteStop,
  ServiceAlert,
  TransitRoute,
  TransitStop,
  TransportMode,
  TripFare,
  TripItinerary,
  TripLeg,
  TripPlan,
  TripRemark,
  VehicleJourney,
  VehicleJourneyStop,
  VehiclePosition,
} from "./types/transit";

// Utils
export { applyHoursFilter } from "./utils/categoryFilter";
export { haversineDistance, lngLatToString, roundCoord } from "./utils/coordinates";
export {
  buildElevationProfile,
  buildElevationProfileFromApi,
  computeElevationStats,
  computeGrades,
  downsampleLTTB,
} from "./utils/elevation";
export {
  formatArea,
  formatDistance,
  formatDuration,
  formatMeasurementDistance,
  getInitials,
} from "./utils/formatting";
export { boundingBoxFromPoints, isPointInBBox } from "./utils/geo";
export {
  geocodeStopAsPlace,
  makeSyntheticStopPlace,
  resolveStopAsPlace,
} from "./utils/geocodeStopAsPlace";
export { formatAddress, legalConfig } from "./utils/legalConfig";
export type {
  DaySchedule,
  LocationContext,
  OpeningHoursStatus,
} from "./utils/openingHours";
export { isAlwaysOpen, isOpenAt, parseOpeningHours } from "./utils/openingHours";
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
export { resolvePoiIconPath } from "./utils/poi-icon";
export { sectionSlug } from "./utils/sectionSlug";
