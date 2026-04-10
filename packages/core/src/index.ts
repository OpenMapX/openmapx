// Platform

export { fetchCapabilities, isServiceAvailable } from "./api/capabilities";
// API
export {
  ApiClient,
  type ApiClientConfig,
  apiClient,
  configureApiClient,
  proxyImageUrl,
} from "./api/client";
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
// Domains
export type {
  CurrentWeather,
  DailyForecastPoint,
  DataSourceProvider as DomainDataSourceProvider,
  DomainDefinition,
  DomainId,
  EnrichmentProvider,
  EnrichmentResult,
  EnrichmentSource,
  GeocodingProvider,
  GeoJsonFeatureCollection,
  HourlyForecastPoint,
  MapOverlayData,
  MapOverlayDetail,
  MapOverlayProvider,
  PhotoProvider,
  PoiSearchProvider,
  PoiSearchResult,
  RoutingOptions,
  RoutingProvider,
  StreetViewProvider,
  TransitProvider,
  WeatherAttribution,
  WeatherOptions,
  WeatherProvider,
  WeatherResponse,
} from "./domains";
export { DOMAIN_DEFINITIONS } from "./domains";
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
export { useActiveSidePanel } from "./hooks/useActiveSidePanel";
export { useAdaptiveDebounce } from "./hooks/useAdaptiveDebounce";
export { useAutocomplete } from "./hooks/useAutocomplete";
export { type ServiceCapability, useCapabilities } from "./hooks/useCapabilities";
export { isAreaTooLarge, useCategorySearch } from "./hooks/useCategorySearch";
// Hooks — General
export { useCurrentWeather } from "./hooks/useCurrentWeather";
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
export { useIntegrationOverlayActive } from "./hooks/useIntegrationOverlay";
// Integration hooks
export { IntegrationRegistryContext, useIntegrationRegistry } from "./hooks/useIntegrationRegistry";
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
export { type SunTimesResponse, useSunTimes } from "./hooks/useSunTimes";
// Integration framework
export type {
  CacheClient,
  CommunityIntegrationModule,
  CustomHealthCheckFn,
  DatabaseClient,
  HealthCheckResult,
  HttpClient,
  HttpClientOptions,
  IntegrationContext,
  IntegrationDataSource,
  IntegrationEvent,
  IntegrationFrontend,
  IntegrationHealthCheck,
  IntegrationLayerSelector,
  IntegrationManifest,
  IntegrationOverlay,
  IntegrationSearchCategory,
  IntegrationStrings,
  LoadedIntegration,
  LoadedIntegrationMeta,
  Logger,
  ManifestValidationResult,
  RouteHandler,
} from "./integration";
export {
  getCommunityModule,
  getCommunityModuleIds,
  IntegrationEventBus,
  IntegrationRegistry,
  initCommunityIntegrationRegistry,
  integrationManifestSchema,
  PLATFORM_VERSION,
  registerCommunityModule,
  satisfiesPlatformVersion,
  toIntegrationMeta,
  validateManifest,
} from "./integration";
export type { PanelId } from "./panels/ids";
export { PANEL } from "./panels/ids";
export { getPanel, getPanelsByLayer, PANEL_REGISTRY } from "./panels/registry";
// Panel system
export type { PanelDefinition, PanelLayer } from "./panels/types";
export { configureStorage, getStorage, type StorageAdapter } from "./platform";
// Core stores (platform-level, stay in packages/core)
export { useCategorySearchStore } from "./stores/categorySearchStore";
export type { OverlayStoreBase } from "./stores/createOverlayStore";
export {
  createOverlayStore,
  getRegisteredOverlayIds,
  getRegisteredOverlayStore,
} from "./stores/createOverlayStore";
export { useDataSourceStore } from "./stores/dataSourceStore";
export type { DirectionsState } from "./stores/directionsStore";
export { useDirectionsStore } from "./stores/directionsStore";
export type { MapLayer } from "./stores/layerStore";
export { useLayerStore } from "./stores/layerStore";
export { useMapClickStore } from "./stores/mapClickStore";
export { useMapStore } from "./stores/mapStore";
export { useMenuStore } from "./stores/menuStore";
export type { OpeningHoursFilter } from "./stores/openingHoursStore";
export { useOpeningHoursStore } from "./stores/openingHoursStore";
export type { OverlayEntry, OverlayId } from "./stores/overlayRegistry";
export {
  closeExclusionPeers,
  getOverlayEntry,
  initOverlayRegistry,
  isOverlayActive,
  OVERLAY_REGISTRY,
  registerOverlayEntry,
  toggleOverlay,
} from "./stores/overlayRegistry";
export { usePlaceStore } from "./stores/placeStore";
export { useSavedPlacesStore } from "./stores/savedPlacesStore";
export { useSearchStore } from "./stores/searchStore";
export { useSidebarStore } from "./stores/sidebarStore";
// Types
export type {
  CategoryDefinition,
  CategoryId,
  CategoryPlace,
  CategorySearchResponse,
} from "./types/category";
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
// Types that originated in integration stores but are used by core utilities
export type { BBox, BoundingBox, LngLat, UnitSystem } from "./types/geometry";
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
  GeoJSONLineString,
  GeoJSONMultiLineString,
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
export type {
  RadarFrame,
  RadarMeta,
  TemperatureUnit,
  WeatherSubLayer,
  WindSpeedUnit,
} from "./types/weather";
export {
  buildAttributionHtml,
  buildIntegrationAttribution,
  combineAttributions,
} from "./utils/attribution";
export { withCache } from "./utils/cache-helpers";
export { applyHoursFilter } from "./utils/categoryFilter";
// Utils
export {
  type CommonsPage,
  fetchCommonsMetadata,
  parseCommonsPage,
} from "./utils/commons-metadata";
export { haversineDistance, lngLatToString, roundCoord } from "./utils/coordinates";
export {
  buildElevationProfile,
  buildElevationProfileFromApi,
  computeElevationStats,
  computeGrades,
  downsampleLTTB,
} from "./utils/elevation";
export { ConfigurationError } from "./utils/errors";
export { escapeHtml, formatTime, relativeTime, sanitizeUrl } from "./utils/format";
export {
  formatArea,
  formatDistance,
  formatDuration,
  formatMeasurementDistance,
  getInitials,
} from "./utils/formatting";
export {
  FPTF_PRODUCT_MODE,
  mapProducts,
  normalizeFptfDeparture,
  normalizeRemarks,
  productToMode,
} from "./utils/fptf";
export { boundingBoxFromPoints, isPointInBBox } from "./utils/geo";
export {
  bboxContains,
  diceSimilarity,
  haversineMeters,
  mergeAttributions,
} from "./utils/geo-server";
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
export { otpMode } from "./utils/otp";
export {
  buildNodeMap,
  buildWayMap,
  OverpassRateLimitError,
  OverpassTimeoutError,
  overpassQuery,
  overpassQuerySafe,
  reconstructLineString,
  reconstructMultiLineString,
  reconstructMultiPolygon,
  reconstructPolygon,
} from "./utils/overpass";
export type {
  LineStringGeometry,
  MultiLineStringGeometry,
  MultiPolygonGeometry,
  OverpassElement,
  OverpassNode,
  OverpassRelation,
  OverpassResponse,
  OverpassWay,
  PolygonGeometry,
} from "./utils/overpass/types";
export { CATEGORY_FILTERS, searchByCategory } from "./utils/overpass.service";
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
export { decodePolyline, encodePolyline } from "./utils/polyline";
export { sectionSlug } from "./utils/sectionSlug";
export {
  type WeatherCodeInfo,
  weatherCodeToDescription,
  weatherCodeToIcon,
  weatherCodeToInfo,
} from "./utils/weatherCodes";
