// Platform

export type {
  AutocompleteResult,
  ReverseGeocodingResult,
  SearchResult,
} from "@integrations/geocoding/types";
// Types
export type {
  CategoryDefinition,
  CategoryId,
  CategoryPlace,
  CategorySearchResponse,
} from "@integrations/poi-search/types";
export {
  CATEGORY_DEFINITIONS,
  categoryPlaceToPlace,
  HOURS_FILTER_CATEGORY_IDS,
} from "@integrations/poi-search/types";
export type {
  Review,
  ReviewAction,
  ReviewAggregate,
  ReviewAuthor,
  ReviewImage,
  ReviewMetadata,
  ReviewProvider,
  ReviewSubject,
} from "@integrations/reviews/types";
export type {
  DirectionsResult,
  IsochroneContour,
  IsochroneGeometry,
  IsochroneMultiPolygon,
  IsochronePolygon,
  IsochroneResult,
  IsochroneTravelMode,
  Route,
  RouteLeg,
  RouteStep,
  TravelMode,
  Waypoint,
} from "@integrations/routing/types";
export type {
  CurrentWeather,
  DailyForecastPoint,
  HourlyForecastPoint,
  RadarFrame,
  RadarMeta,
  TemperatureUnit,
  WeatherOptions,
  WeatherResponse,
  WeatherSubLayer,
  WindSpeedUnit,
} from "@integrations/weather/types";
export type {
  DataSourceAttribution,
  DataSourceBranding,
  DataSourceDetail,
  DataSourceDetailSection,
  DataSourceFilterDef,
  DataSourceGeoJsonFeature,
  DataSourceGeoJsonFeatureCollection,
  DataSourceGeoJsonGeometry,
  DataSourceMapContext,
  DataSourceMapContextSelection,
  DataSourceMarkerStyle,
  DataSourceMeta,
  DataSourceResult,
  OsmIdentity,
  PricingPlanEntry,
} from "@openmapx/integration-framework";
export { fetchCapabilities, isServiceAvailable } from "./api/capabilities";
// API
export {
  ApiClient,
  type ApiClientConfig,
  apiClient,
  apiUrl,
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
export { MODE_COLORS } from "./constants/transit";
// Domains
export type {
  GeoJsonFeatureCollection,
  KnowledgeContext,
  KnowledgeProvider,
  KnowledgeResult,
  MapOverlayData,
  MapOverlayDetail,
  MapOverlayProvider,
  StreetViewProvider,
} from "./domains";

// Git URL allowlist (shared by community service repos + community integrations).
// The `gitShallowClone*` helpers that use these live in `./server` — they import
// `node:fs` and would break the client bundle if re-exported here.

// `repoPaths`, the `services` namespace, and `spawnWithBufferedLogs` use node:fs
// / node:child_process — they live in `./server`, not this client-reachable barrel.
export { ALLOWED_GIT_HOSTS, assertAllowedGitUrl, InvalidGitUrlError } from "./git-url";
// Hooks — Transit
export {
  resolvePrimaryTransitStopId,
  useArrivals,
  useDepartures,
  useLinkedTransitAlerts,
  useLinkedTransitArrivals,
  useLinkedTransitDepartures,
  useLinkedTransitFacilities,
  useLinkedTransitRoutes,
  useLinkedTransitStops,
  usePlaceStopInfrastructure,
  useRouteAlerts,
  useRouteLive,
  useRouteStops,
  useRoutesForStop,
  useStopAlerts,
  useStopFacilities,
  useStopInfrastructure,
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
export { type AirportSearchHit, useAirportSearch } from "./hooks/useAirportSearch";
export { useAutocomplete } from "./hooks/useAutocomplete";
export { type ServiceCapability, useCapabilities } from "./hooks/useCapabilities";
export { isAreaTooLarge, useCategorySearch } from "./hooks/useCategorySearch";
export { useChipTranslations } from "./hooks/useChipTranslations";
// Hooks — General
export { useCurrentWeather } from "./hooks/useCurrentWeather";
export { useDataSourceMatch } from "./hooks/useDataSourceMatch";
// Hooks — Data Sources
export {
  useDataSourceDetail,
  useDataSourceMapContext,
  useDataSourceSearch,
  useDataSources,
} from "./hooks/useDataSources";
export { useDebounce, useDebouncedCallback } from "./hooks/useDebounce";
export { useDirections } from "./hooks/useDirections";
export { useElevation } from "./hooks/useElevation";
export { useExploreResults } from "./hooks/useExploreResults";
export { useFilteredCategoryResults } from "./hooks/useFilteredCategoryResults";
export { useFlightProviders } from "./hooks/useFlightProviders";
export { useGeocoding } from "./hooks/useGeocoding";
export {
  useHikingArea,
  useHikingDetail,
  useHikingGeometry,
  useHikingSearch,
  useHikingShelters,
} from "./hooks/useHikingTrails";
export { useIntegrationOverlayActive } from "./hooks/useIntegrationOverlay";
export { useIsochrone } from "./hooks/useIsochrone";
export {
  type DouglasSeaState,
  type MarineCurrent,
  type MarineHourlyPoint,
  type MarineWeatherResponse,
  useMarineWeather,
} from "./hooks/useMarineWeather";
export { useMergedPlace } from "./hooks/useMergedPlace";
export { type NearestAirportHit, useNearestAirports } from "./hooks/useNearestAirports";
export { useOptimizeRoute } from "./hooks/useOptimizeRoute";
export { useOverlayExclusion } from "./hooks/useOverlayExclusion";
export { usePlaceDetails } from "./hooks/usePlaceDetails";
export { usePlacePhotos } from "./hooks/usePlacePhotos";
export { usePresetSuggest } from "./hooks/usePresetSuggest";
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
export {
  type MetObservation,
  type TideCurvePoint,
  type TideEvent,
  type TidesResponse,
  useTides,
  type WaterLevelObservation,
} from "./hooks/useTides";
export type { PanelId } from "./panels/ids";
export { PANEL } from "./panels/ids";
export { getPanel, getPanelsByLayer, PANEL_REGISTRY } from "./panels/registry";
// Panel system
export type { PanelDefinition, PanelLayer } from "./panels/types";
export { configureStorage, getStorage, type StorageAdapter } from "./platform";
export { useCategoryFacetStore } from "./stores/categoryFacetStore";
// Core stores (platform-level, stay in packages/core)
export { useCategorySearchStore } from "./stores/categorySearchStore";
export { useCommandPaletteStore } from "./stores/commandPaletteStore";
export type { OverlayStoreBase } from "./stores/createOverlayStore";
export {
  createOverlayStore,
  getRegisteredOverlayIds,
  getRegisteredOverlayStore,
} from "./stores/createOverlayStore";
export { useDataSourceStore } from "./stores/dataSourceStore";
export type { DirectionsState } from "./stores/directionsStore";
export { useDirectionsStore } from "./stores/directionsStore";
export { type FlightEndpoint, useFlightStore } from "./stores/flightStore";
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
export type {
  ElevationApiResponse,
  ElevationPoint,
  ElevationProfile,
  ElevationStats,
} from "./types/elevation";
export type {
  CabinClass,
  FlightProviderCapabilities,
  FlightProviderInfo,
  FlightSearchParams,
} from "./types/flights";
// Types that originated in integration stores but are used by core utilities
export type { AreaGeometry, BBox, BoundingBox, LngLat, UnitSystem } from "./types/geometry";
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
export type { Identified, Ids } from "./types/identified";
export { makeId, parseId, withId } from "./types/identified";
export type {
  DaySchedule,
  LocationContext,
  OpeningHoursInfo,
  OpeningHoursStatus,
} from "./types/openingHoursInfo";
export type {
  AirportFrequencyInfo,
  AirportInfo,
  AirportNavaidInfo,
  AirportRunwayInfo,
  AirportType,
  Place,
  PlaceFact,
  PlaceIds,
  PlacePhoto,
  PlaceReviewLink,
} from "./types/place";
export {
  coordinateId,
  createPlace,
  idsFromPrimary,
  idsFromPrimaryOrCoords,
} from "./types/placeIds";
export type { LabeledPlace, SavedList, SavedPlace } from "./types/saved";
export {
  buildAttributionHtml,
  buildIntegrationAttribution,
  buildRuntimeAttributionHtml,
  buildSourceAttribution,
  combineAttributions,
  extractSourcePrefix,
  pickIntegrationForSources,
} from "./utils/attribution";
export { bboxAroundPoint } from "./utils/bbox";
export { withCache } from "./utils/cache-helpers";
export type { CategoryFacet, FacetPlacement, FacetType } from "./utils/categoryFacets";
export {
  applyFacetFilters,
  CATEGORY_FACETS,
  cuisineOptions,
  facetsForCategory,
} from "./utils/categoryFacets";
export { applyHoursFilter } from "./utils/categoryFilter";
// Utils
export {
  type CommonsPage,
  fetchCommonsMetadata,
  parseCommonsPage,
} from "./utils/commons-metadata";
export { haversineDistance } from "./utils/coordinates";
export { applyClientSideFilters, splitFilters } from "./utils/dataSourceFilters";
export {
  buildElevationProfile,
  buildElevationProfileFromApi,
  computeElevationStats,
  computeGrades,
  downsampleLTTB,
} from "./utils/elevation";
export { ConfigurationError } from "./utils/errors";
export {
  assertValidFeedSlug,
  InvalidFeedSlugError,
  isValidFeedSlug,
  normalizeFeedSlug,
} from "./utils/feed-slug";
export { DEFAULT_FETCH_TIMEOUT_MS, type FetchJsonOptions, fetchJson } from "./utils/fetchJson";
export {
  type FetchWithRedirectsOptions,
  fetchWithRedirects,
} from "./utils/fetchWithRedirects";
export { buildFlightOpenUrl } from "./utils/flightLink";
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
export {
  bboxContains,
  diceSimilarity,
  haversineKm,
  haversineMeters,
  mergeAttributions,
} from "./utils/geo-server";
export {
  geocodeStopAsPlace,
  makeSyntheticStopPlace,
  resolveStopAsPlace,
} from "./utils/geocodeStopAsPlace";
export { estimateFlightMinutes, greatCircleArc } from "./utils/greatCircle";
export { formatAddress, legalConfig } from "./utils/legalConfig";
export { isOpenAtBitmap, isOpenAtSlot } from "./utils/openingHoursClient";
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
  setOverpassUrl,
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
export type { OsmFilter } from "./utils/overpass.service";
export {
  CATEGORY_FILTERS,
  searchByCategory,
  searchByOsmTags,
  searchByText,
} from "./utils/overpass.service";
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
export { pointInIsochroneGeometry } from "./utils/pointInPolygon";
export { decodePolyline, encodePolyline } from "./utils/polyline";
export { sectionSlug } from "./utils/sectionSlug";
export type { TideExtremaOptions, TideExtreme, TideSample } from "./utils/tideExtrema";
export { despikeSeries, findTideExtrema } from "./utils/tideExtrema";
export {
  USER_AGENT,
  USER_AGENT_ADMIN,
  USER_AGENT_TRANSIT,
  userAgent,
} from "./utils/userAgent";
export { isPublicUrl, validatePublicUrl } from "./utils/validate-url";
export {
  type WeatherCodeInfo,
  weatherCodeToDescription,
  weatherCodeToIcon,
  weatherCodeToInfo,
} from "./utils/weatherCodes";
