export type { CommunityIntegrationModule } from "./community";
export {
  getCommunityModule,
  getCommunityModuleIds,
  getCommunityModulesVersion,
  initCommunityIntegrationRegistry,
  registerCommunityModule,
  subscribeCommunityModules,
} from "./community";
export type {
  AiSearchDisclosure,
  AttributionIndexHandle,
  CacheClient,
  CloudAiVendor,
  CustomHealthCheckFn,
  DatabaseClient,
  Disclosure,
  EmailDisclosure,
  EmailProvider,
  HealthCheckResult,
  HttpClient,
  HttpClientOptions,
  IntegrationContext,
  LiveStoreClient,
  Logger,
  MetricsRecorder,
  ProviderCallOutcome,
  ProviderHealthHandle,
  RouteHandler,
  RouteOptions,
  SecretsClient,
  TransferSafeguard,
} from "./context";
export {
  assertProviderSatisfiesContract,
  assertRealtimeProviderContract,
  assertTransitProviderContract,
} from "./contracts/assert-contract";
export type {
  AutocompleteResult,
  CurrentWeather,
  DailyForecastPoint,
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
  DirectionsResult,
  GeocodingProvider,
  GtfsCatalogFeed,
  GtfsCatalogProvider,
  HourlyForecastPoint,
  IsochroneContour,
  IsochroneGeometry,
  IsochroneMultiPolygon,
  IsochronePolygon,
  IsochroneResult,
  IsochroneTravelMode,
  KnowledgeContext,
  KnowledgeProvider,
  KnowledgeResult,
  ManeuverLane,
  ManeuverSign,
  MatchEdge,
  MatchOptions,
  MatchPoint,
  MatchResult,
  MatchShapeMatch,
  MatchTracePoint,
  MobilityDataSourceProvider,
  NlpProvider,
  NlpProviderId,
  OsmIdentity,
  ParseContext,
  PhotoProvider,
  PhotoQuery,
  PoiSearchProvider,
  PoiSearchResult,
  PricingPlanEntry,
  ProviderAttribution,
  RealtimeCapabilities,
  RealtimeProvider,
  ReverseGeocodingResult,
  Review,
  ReviewAction,
  ReviewAggregate,
  ReviewAuthor,
  ReviewImage,
  ReviewMetadata,
  ReviewProvider,
  ReviewSubject,
  RoadConditionAttribution,
  RoadConditionEvent,
  RoadConditionRoadRef,
  RoadConditionScheduleWindow,
  RoadConditionSeverity,
  RoadConditionsProvider,
  RoadConditionsQuery,
  RoadConditionType,
  RoadState,
  Route,
  RouteLeg,
  RouteStep,
  RoutingOptions,
  RoutingProvider,
  SearchIntent,
  SearchResult,
  SpatialConstraint,
  TimeConstraint,
  TimetableEntry,
  TransitCapabilities,
  TransitProvider,
  TravelMode,
  TripPlanRequest,
  TripUpdate,
  VehicleJourney,
  Waypoint,
  WeatherOptions,
  WeatherProvider,
  WeatherResponse,
} from "./contracts/index.js";
export { isPlausibleNlSearch, NL_CONFIDENCE_FLOOR } from "./contracts/search-nlp-provider";
export type { IntegrationEvent } from "./events";
export { IntegrationEventBus } from "./events";
export { httpError } from "./http-error";
// Installer exports (`buildIntegration` / `installIntegration` / `listIntegrations`
// / `removeIntegration` / `validateIntegrationDirectory` and their option/result
// types) intentionally do NOT live in this barrel. `installer.ts` imports
// node:fs/crypto/os/path, and any barrel that re-exports it taints everyone
// who imports the barrel — including the client-reachable `@openmapx/core`
// main entry. Consumers import them from `@openmapx/core/server` instead.
export type {
  IntegrationStrings,
  IntegrationsResponse,
  LoadedIntegration,
  LoadedIntegrationMeta,
} from "./loader";
export { toIntegrationMeta } from "./loader";
export type {
  CredentialSetup,
  IntegrationDataSource,
  IntegrationFrontend,
  IntegrationHealthCheck,
  IntegrationLayerSelector,
  IntegrationManifest,
  IntegrationOverlay,
  IntegrationOverlayLegend,
  IntegrationSearchCategory,
  ManifestAttributionStore,
  ManifestValidationResult,
} from "./manifest";
export {
  createManifestAttribution,
  credentialSetupSchema,
  dataSourceToAttribution,
  INTEGRATION_ID_REGEX,
  integrationManifestSchema,
  readCredentialSetup,
  validateManifest,
} from "./manifest";
export { PLATFORM_VERSION, satisfiesPlatformVersion } from "./platform";
export {
  createStaticPoiReader,
  createTwoTierPoiReader,
  isInColdStart,
  isLiveTooStale,
  type PoiReader,
  type StaticPoiReaderOptions,
  type TwoTierPoiReaderOptions,
} from "./poi-source-reader";
export { IntegrationRegistry } from "./registry";
// `useIntegrationRegistry` and `IntegrationRegistryContext` live in the
// `/react` subpath — pulling them into this barrel would force every
// consumer (CLI, API, server-side code) to ship `react` even when they
// only need server-safe symbols like `PLATFORM_VERSION` or `validateManifest`.
export {
  createFallbackChain,
  createFirstWins,
  createMergeAll,
  type FallbackChainOptions,
  type MergeAllOptions,
} from "./strategies";
export {
  createTidesIntegration,
  type TideStationBase,
  type TidesIntegrationConfig,
} from "./tides-integration-factory";
export { defineTransitProvider, type TransitProviderScaffold } from "./transit-provider-factory";
