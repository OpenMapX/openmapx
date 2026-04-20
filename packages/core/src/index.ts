// Platform

export type {
  DataSourceAttribution,
  DataSourceDetail,
  DataSourceDetailSection,
  DataSourceFilterDef,
  DataSourceMarkerStyle,
  DataSourceMeta,
  DataSourceResult,
  PricingPlanEntry,
} from "@integrations/data-source/types";
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
} from "@integrations/transit/types";
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
  GeoJsonFeatureCollection,
  KnowledgeProvider,
  KnowledgeResult,
  KnowledgeSource,
  MapOverlayData,
  MapOverlayDetail,
  MapOverlayProvider,
  StreetViewProvider,
} from "./domains";
// Git URL allowlist (shared by community service repos + community integrations).
// The `gitShallowClone*` helpers that use these live in `./server` — they import
// `node:fs` and would break the client bundle if re-exported here.

export { ALLOWED_GIT_HOSTS, assertAllowedGitUrl, InvalidGitUrlError } from "./git-url";
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
export { useDataSourceMatch } from "./hooks/useDataSourceMatch";
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
// Hooks — Reviews (Mangrove)
export { usePlaceReviews, useReviewAggregate } from "./hooks/usePlaceReviews";
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
export { type SubmitReviewInput, useSubmitReview } from "./hooks/useSubmitReview";
export { type SunTimesResponse, useSunTimes } from "./hooks/useSunTimes";
export { useUploadReviewImage } from "./hooks/useUploadReviewImage";
export {
  type AddPassphraseWrapInput,
  type AddWebAuthnWrapInput,
  type AddWrapInput,
  type EnvelopeState,
  type KeypairEncryptionMode,
  type KeypairEnvelope,
  type KeypairEnvelopeEncrypted,
  type KeypairEnvelopeUnencrypted,
  type KeypairWrap,
  type KeypairWrapType,
  type SetupInput,
  type SetupPassphraseAndWebAuthnInput,
  type SetupPassphraseInput,
  type SetupUnencryptedInput,
  type UnlockInput,
  type UnlockPassphraseInput,
  type UnlockWebAuthnInput,
  useAddWrap,
  useChangePassphrase,
  useImportMangroveKeypair,
  useKeypairState,
  useMangroveKeypairExport,
  useRefreshKeypair,
  useRegenerateMangroveKeypair,
  useRemoveWrap,
  useSetupKeypair,
  useUnlockKeypair,
  useUserKeypair,
} from "./hooks/useUserKeypair";
export type { IdSchemeView, PlaceResolver, PlaceResolverContext } from "./ids";
export {
  getIdSchemeView,
  getPlaceResolver,
  listIdSchemeViews,
  listPlaceResolverSchemes,
  registerBuiltinIdSchemeViews,
  registerIdSchemeView,
  registerPlaceResolver,
} from "./ids";
// Integration framework. Installer-family exports (buildIntegration,
// installIntegration, removeIntegration, validateIntegrationDirectory, plus
// their InstallOptions/BuildOptions/ValidateResult/IntegrationSummary
// companions) live in `./server` — they use node:fs and would pull node-only
// modules into the client bundle if re-exported here.
export type {
  CacheClient,
  CommunityIntegrationModule,
  CustomHealthCheckFn,
  DatabaseClient,
  FallbackChainOptions,
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
  MergeAllOptions,
  RouteHandler,
  RouteOptions,
} from "./integration";
export {
  createFallbackChain,
  createFirstWins,
  createMergeAll,
  getCommunityModule,
  getCommunityModuleIds,
  INTEGRATION_ID_REGEX,
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
// Mangrove (Open Reviews Standard)
export {
  base64UrlToBytes,
  buildMangroveSubjectUri,
  bytesToBase64Url,
  createWebAuthnIdentity,
  DEFAULT_UNCERTAINTY_METERS,
  decryptWithPassphrase,
  decryptWithWebAuthn,
  EXPERIENCE_CONTEXT_GEO,
  encryptForWebAuthnIdentities,
  encryptWithPassphrase,
  fingerprintPem,
  type GeoExperienceContext,
  generateKeypair,
  isWebAuthnAvailable,
  jwkToKeypair,
  keypairToJwk,
  MANGROVE_JWK_METADATA,
  type MangroveExportJwk,
  type MangroveKeypair,
  type MangroveReviewPayload,
  type MangroveSubject,
  publicKeyToPem,
  type SerializedMangroveKeypair,
  signMangroveReview,
  toMangroveExportJwk,
  WEBAUTHN_CREDENTIAL_KEY_NAME,
} from "./mangrove";
export type { PanelId } from "./panels/ids";
export { PANEL } from "./panels/ids";
export { getPanel, getPanelsByLayer, PANEL_REGISTRY } from "./panels/registry";
// Panel system
export type { PanelDefinition, PanelLayer } from "./panels/types";
export { configureStorage, getStorage, type StorageAdapter } from "./platform";
// `repoPaths`, the `services` namespace, and `spawnWithBufferedLogs` use node:fs
// / node:child_process — they live in `./server`, not this client-reachable barrel.
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
export { useKeypairStore } from "./stores/keypairStore";
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
export type { Identified, Ids } from "./types/identified";
export { makeId, parseId, withId } from "./types/identified";
export type { Place, PlaceFact, PlaceIds, PlacePhoto, PlaceReviewLink } from "./types/place";
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
  buildSourceAttribution,
  combineAttributions,
  extractSourcePrefix,
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
export { applyClientSideFilters, splitFilters } from "./utils/dataSourceFilters";
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
