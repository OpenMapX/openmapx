// The curated headless navigation surface.
//
// Everything exported here must be safe to run inside a background TaskManager
// callback: no React, no Zustand, no auth client, no browser storage, no DOM.
// `headlessBoundary.test.ts` bundles this barrel and fails on any of those, and
// `pnpm mobile:bundle:check` repeats the check against the real Metro graph.

export type { Route } from "../types/routing";
// Guidance distance rounding, here so the mobile shell needn't load the core root.
export {
  formatMeasurementDistance,
  type MeasurementDistanceParts,
  measurementDistanceParts,
} from "../utils/formatting";
export {
  type ActiveAlert,
  brakingDistanceMeters,
  CAMERA_RESTRICTED_COUNTRIES,
  type RoadAlert,
  type RoadAlertType,
  selectActiveAlert,
  shouldWarnCamera,
} from "./alerts";
export { angularDifference, bearingBetween, routeBearingAt } from "./bearing";
export {
  type CarCamera,
  type CarNativeToWebMessage,
  type CarPosition,
  type CarPreview,
  type CarSurfaceMessage,
  type CarViewport,
  type CarWebToNativeMessage,
  carCameraSchema,
  carNativeToWebSchema,
  carPositionSchema,
  carPreviewSchema,
  carSurfaceMessageSchema,
  carViewportSchema,
  carWebToNativeSchema,
  parseCarSurfaceMessage,
} from "./carSurfaceProtocol";
export { type CoastOptions, type CoastResult, coastState } from "./coast";
export {
  cumulativeDistances,
  type DeadReckonOptions,
  type DeadReckonTarget,
  positionAt,
  stepDeadReckon,
} from "./deadReckon";
export { eta } from "./eta";
export {
  evaluateFasterRoute,
  FASTER_ROUTE_DEFAULTS,
  type FasterRouteCandidate,
  type FasterRouteEvaluation,
  type FasterRouteOptions,
} from "./fasterRoute";
export {
  flowSeverityRank,
  type ProjectFlowOptions,
  projectFlowToRoute,
  routeFingerprint,
} from "./flowProjection";
export type {
  BuildGroundPackageInput,
  BuildGroundPackageResult,
  GroundNavigationSettings,
  GroundPackageError,
} from "./groundPackage";
export { buildGroundNavigationPackage } from "./groundPackage";
export {
  type GuidanceIconName,
  type GuidanceLaneArrow,
  type GuidanceLaneCell,
  laneArrowStemShift,
  laneIndicationIconName,
  maneuverIconName,
  normalizeLaneToken,
  presentGuidanceLanes,
  unmarkedLaneIconName,
} from "./guidanceIcons";
export { formatIncidentAnnouncement, incidentTypeLabelKey } from "./incidentAnnounce";
export {
  type IncidentAlert,
  type ProjectEventsOptions,
  projectEventsToRoute,
} from "./incidentProjection";
export {
  findJunctionCandidates,
  findJunctionDecisionPoints,
  sameJunction,
} from "./junctionDetect";
export { junctionLookupPoints } from "./junctionLookup";
export {
  guidanceApproachMeters,
  type ResolvedLaneGuidance,
  resolveGuidanceLanes,
  resolveLaneGuidance,
  resolveRecommendedLanes,
  shouldPreviewNextStep,
} from "./lanes";
export {
  type ApproachLaneGuidance,
  laneDestinationsAt,
  resolveApproachLaneGuidance,
  selectApproachWay,
  selectRampWay,
} from "./laneTags";
export { isLiveNavigationStatus } from "./liveStatus";
export {
  type ManeuverArrowSpans,
  maneuverArrowLine,
  maneuverArrowSpans,
  maneuverArrowTipBearing,
} from "./maneuverArrow";
export {
  type ManeuverPositions,
  maneuverStartMeters,
  prepareManeuverPositions,
} from "./maneuverPosition";
export {
  type CarDestination,
  type CarDestinations,
  carDestinationSchema,
  carDestinationsSchema,
  enforceAggregateBounds,
  type GroundNavigationStartPackage,
  groundStartPackageSchema,
  MAX_LEGS,
  MAX_MESSAGE_BYTES,
  MAX_TOTAL_COORDINATES,
  MAX_TOTAL_STEPS,
  MOBILE_PROTOCOL_MAX,
  MOBILE_PROTOCOL_MIN,
  type MobileBridgeEnvelope,
  type MobileBridgeMessage,
  mobileBridgeMessageSchema,
  NATIVE_TO_WEB_TYPES,
  type NativeCapabilities,
  type NativeToWebMessage,
  type NavigationStartPackage,
  nativeToWebSchema,
  navigationStartPackageSchema,
  negotiateMobileProtocol,
  type ParseErrorCode,
  type ParseResult,
  parseMobileBridgeMessage,
  permissionStateSchema,
  type TransitLegCapture,
  type TransitNavigationStartPackage,
  transitStartPackageSchema,
  transitStopAreaSchema,
  type VoiceEvent,
  voiceEventSchema,
  WEB_TO_NATIVE_TYPES,
  type WebToNativeMessage,
  webToNativeSchema,
} from "./mobileProtocol";
export {
  appendToLedger,
  type GroundMobileSession,
  isMobileSessionExpired,
  MOBILE_NAVIGATION_SESSION_MAX_AGE_MS,
  MOBILE_NAVIGATION_SESSION_SCHEMA_VERSION,
  MOBILE_SESSION_LEDGER_LIMIT,
  type MobileNavigationSession,
  type MobileTerminalAck,
  mobileNavigationSessionSchema,
  mobileTerminalAckSchema,
  parseMobileSession,
  type RedactedSession,
  redactSessionForDiagnostics,
  type SessionParseResult,
  type TransitMobileSession,
} from "./mobileSession";
export * from "./nativeIntake";
export {
  createNavigationSessionSnapshot,
  isNavigationSessionExpired,
  NAVIGATION_SESSION_MAX_AGE_MS,
  NAVIGATION_SESSION_SCHEMA_VERSION,
  type NavigationSessionSnapshot,
  navigationSessionFingerprint,
  parseNavigationSessionSnapshot,
} from "./offlineSession";
export { navOptionsForMode } from "./options";
export { processFix } from "./processFix";
export {
  DEFAULT_TRANSIT_TICK_OPTIONS,
  freshTransitTickState,
  processTransitFix,
  TRANSIT_UNDO_WINDOW_MS,
  type TransitConfidence,
  type TransitNavigationEvent,
  type TransitPhase,
  type TransitRiderAction,
  type TransitTickInput,
  type TransitTickOptions,
  type TransitTickResult,
  type TransitTickState,
  transitProgressFromTick,
} from "./processTransitFix";
export { computeProgress, stepStartMeters, upcomingManeuverIndex } from "./progress";
export {
  extractTimeline,
  freshNavTickState,
  NAV_RECORDING_VERSION,
  type NavRecording,
  type RecordedReroute,
  type ReplayStep,
  replayRecording,
  SIGNAL_LOST_GAP_MS,
  type TimelineEvent,
  type TimelineEventType,
} from "./recording";
export {
  isReroutingTooOften,
  pruneRerouteTimes,
  remainingWaypoints,
  shouldReroute,
  shouldRerouteForClosure,
  updateOffRouteScore,
} from "./reroute";
export { type AlongRange, projectRoadAlertsOntoRoute } from "./roadAlertProjection";
export { isNearRoute, ROUTE_CORRIDOR_METERS } from "./routeCorridor";
export {
  appendCountrySpans,
  countryAtMeters,
  matchCountriesByPoint,
  type RouteCountrySpan,
} from "./routeCountries";
export {
  asRouteMatcher,
  type PreparedRouteMatcher,
  prepareRouteMatcher,
  type RouteMatcherCounters,
  type RouteMatcherInput,
  readRouteMatcherCounters,
  resetRouteMatcherCounters,
  routeMatcherFor,
  setRouteMatcherCounting,
  snapPreparedRoute,
} from "./routeMatcher";
export {
  type EvaluateRouteStopsInput,
  evaluateRouteStopDetours,
  insertRouteStop,
  ROUTE_STOP_CACHE_MS,
  ROUTE_STOP_CONCURRENCY,
  ROUTE_STOP_LIMIT,
  ROUTE_STOP_PROGRESS_METERS,
  type RouteStopCandidate,
  type RouteStopDetour,
  type RouteStopRequest,
  type RouteStopWaypointPosition,
  remainingRouteStopWaypoints,
  routeStopAccess,
  routeStopInsertIndex,
  routeStopWaypointPositions,
} from "./routeStopDetours";
export {
  type AlongRouteOptions,
  type AlongRoutePoi,
  DEFAULT_CORRIDOR_PAD_METERS,
  filterRoutePois,
  PROGRESS_BUCKET_METERS,
  type ProjectedRoutePoi,
  paddedRouteAheadBounds,
  poiAlongRoute,
  progressBucket,
  progressBucketStartMeters,
  projectRoutePois,
  ROUTE_SEARCH_CORRIDOR_METERS,
  type RouteSearchChunk,
  type RouteSearchChunks,
  routeAheadBounds,
  routeSearchChunks,
} from "./searchAlongRoute";
export {
  cleanSignTexts,
  exitNumberLabel,
  refKind,
  signHeadline,
  visibleToward,
} from "./signFormat";
export { simulatePositions } from "./simulatePositions";
export { snapToRoute } from "./snap";
export { isOverSpeed, OVER_SPEED_TOLERANCE_KMH } from "./speedAlert";
export { matchSpeedLimitsByPoint, pickSpeedLimit } from "./speedLimits";
export { spokenInstructionFor } from "./spokenInstruction";
export {
  extractTrafficSignals,
  type GeometryWindow,
  signalCoordKey,
  windowGeometry,
} from "./trafficSignals";
export { transitAlternativeOrigin } from "./transitAlternatives";
export {
  type ConnectionRisk,
  type ConnectionRiskLevel,
  changedFromPlatform,
  collectActiveAlerts,
  connectionRisk,
  itineraryTransferRisk,
  nextTransferFor,
  SEVERITY_PRIORITY,
  type TransitTransfer,
} from "./transitConnection";
export {
  type BuildTransitPackageInput,
  type BuildTransitPackageResult,
  buildTransitNavigationPackage,
  stripTransitSecretsForSnapshot,
  type TransitPackageError,
  transitItineraryFingerprint,
} from "./transitPackage";
export {
  isApproachingTransitAlight,
  type PreparedTransitProgress,
  prepareTransitProgress,
  stopsUntilAlight,
  type TransitProgress,
} from "./transitProgress";
export { mergeTransitRefresh } from "./transitRefresh";
export {
  convexHull,
  DESTINATION_RADIUS_METERS,
  defaultStopAreaShape,
  isWithinStopArea,
  resolveTransitLegTargets,
  spanMeters,
  stopAreaDistance,
  stopAreaShapeDistance,
  stopAreaTolerance,
  type TransitLegTargets,
  type TransitStopAreaIndex,
  type TransitStopAreaNeed,
  transitStopAreaKey,
  transitStopsNeedingAreas,
} from "./transitStopAreas";
export {
  type CapturableLeg,
  captureTransitLegStops,
  type JourneyStopLike,
  refreshTransitCaptures,
  selectLegPlatform,
  sliceJourneyToLeg,
} from "./transitStops";
export {
  composeWalkInstruction,
  type TransitWalkManeuver,
  transitWalkVoiceCue,
  type WalkStepInfo,
  walkLegStepProgress,
  walkStepInfo,
} from "./transitWalk";
export { repairTransitWalk } from "./transitWalkRepair";
export type {
  CameraMode,
  CueTier,
  FixInput,
  NavProgress,
  NavStatus,
  NavTickOptions,
  NavTickResult,
  NavTickState,
  ProgressResult,
  RerouteOpts,
  SnapResult,
  VoiceCue,
  VoiceScheduleConfig,
} from "./types";
export { nextVoiceCue } from "./voiceCue";
