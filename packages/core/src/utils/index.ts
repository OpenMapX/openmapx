export { dataSourceToAttribution } from "@openmapx/mobility-core/contributors";
export { bboxAroundPoint, bboxCacheKey, geoJsonBBox } from "./bbox";
export { isBuildingStyleLayer } from "./buildingStyle";
export { AVERAGE_CAR_CO2_GRAMS_PER_KM, estimateDrivingCo2Grams } from "./co2";
export { haversineDistance } from "./coordinates";
export { applyClientSideFilters, splitFilters } from "./dataSourceFilters";
export {
  DATA_SOURCE_MATCH_METERS,
  type DataSourceMatchCandidate,
  type DataSourceMatchTarget,
  matchDataSourceResults,
} from "./dataSourceMatch";
export {
  type CalendarDateOptions,
  type ClockTimeOptions,
  type DateFormat,
  formatCalendarDate,
  formatClockTime,
  formatDateAndTime,
  formatRecentOrDateTime,
  formatRelativeTime,
  type RecentOrDateOptions,
  type RelativeTimeOptions,
  type TimeFormat,
} from "./dateTimeFormat";
export {
  buildElevationProfile,
  buildElevationProfileFromApi,
  computeElevationStats,
  computeGrades,
  downsampleLTTB,
} from "./elevation";
export { ConfigurationError } from "./errors";
export { beforeFirst, escapeHtml, isSafeHttpUrl, safeHref, sanitizeUrl } from "./format";
export {
  formatArea,
  formatDuration,
  formatMeasurementDistance,
  formatOverviewDistance,
  getInitials,
  type MeasurementDistanceParts,
  measurementDistanceParts,
} from "./formatting";
export {
  FPTF_PRODUCT_MODE,
  fptfLineName,
  mapFptfLoadFactor,
  mapProducts,
  normalizeFptfDeparture,
  normalizeRemarks,
  productToMode,
} from "./fptf";
export {
  bboxContains,
  diceSimilarity,
  haversineKm,
  haversineMeters,
  mergeAttributions,
  nameSimilarity,
  normalizeName,
  normalizePhone,
  normalizeStreet,
  osmAddressKey,
  overtureAddressKey,
  parsePhones,
  websiteDomain,
} from "./geo-server";
export { estimateFlightMinutes, greatCircleArc } from "./greatCircle";
export {
  bearingDelta,
  dominantGridBearing,
  type GridOrientation,
  nearestGridBearing,
  type WeightedBearing,
} from "./gridOrientation";
export { lerpHex } from "./hexColor";
export { indexAt } from "./indexAt";
export { itemAt } from "./itemAt";
export { formatAddress, legalConfig } from "./legalConfig";
export {
  cameraMatrix,
  EARTH_CIRCUMFERENCE_M,
  instanceMatrix,
  type Matrix4,
  type MercatorOrigin,
  mercatorOrigin,
  multiply4,
  objectMatrix,
  scaling4,
  translation4,
} from "./mercatorFrame";
export { numberAt } from "./numberAt";
export { validObservedAt } from "./observationTime";
export {
  parseCoordinateInput,
  parseDMSCoordinateInput,
} from "./parseCoordinates";
export {
  ENDPOINT_URL_TEMPLATE,
  isPlatformEndpointId,
  PLATFORM_ENDPOINTS,
  type PlatformEndpointDefinition,
  type PlatformEndpointInputs,
  platformEndpointServiceId,
  type ResolvedPlatformEndpoint,
  resolvePlatformEndpoint,
} from "./platform-endpoints";
export {
  computePlusCode,
  decodePlusCode,
  decodeShortPlusCode,
  detectShortPlusCodeCity,
  parsePlusCodeInput,
  plusCodeUrl,
  shortenPlusCode,
} from "./plusCode";
export { pointInIsochroneGeometry } from "./pointInPolygon";
export { decodePolyline, encodePolyline } from "./polyline";
export {
  isSystemSavedList,
  MAX_SAVED_LISTS_PER_USER,
  MAX_SAVED_PLACES_PER_USER,
} from "./savedLists";
export { sectionSlug } from "./sectionSlug";
export {
  antisolarPoint,
  type ContourBranch,
  type DarkRegionProperties,
  darkRegion,
  normalizeLongitude,
  type SolarPosition,
  solarAltitudeDeg,
  solarAzimuthDeg,
  solarPosition,
  subsolarPoint,
  type TwilightBandOptions,
  type TwilightBandProperties,
  twilightBands,
} from "./solar";
export {
  clusterSpatialItems,
  type SpatialClusteringOptions,
} from "./spatialClustering";
export {
  bilinear,
  sampleTerrainGrid,
  type TerrainProbe,
  type TerrainSample,
} from "./terrainProbe";
export type { TideExtremaOptions, TideExtreme, TideSample } from "./tideExtrema";
export { despikeSeries, findTideExtrema } from "./tideExtrema";
export {
  formatInTimeZone,
  isoWithOffsetInZone,
  localDateInZone,
  timeZoneAt,
  tzDiffMinutes,
  tzOffsetLabel,
  tzOffsetMinutes,
  viewerTimeZone,
  zonedWallClockToInstant,
} from "./timezone";
export { transitItineraryKey } from "./transitItineraryKey";
export { itineraryMatchesTransitReference } from "./transitTripReference";
export {
  type WeatherCodeInfo,
  weatherCodeToDescription,
  weatherCodeToIcon,
  weatherCodeToInfo,
} from "./weatherCodes";
