// The curated headless navigation surface.
//
// Everything exported here must be safe to run inside a background TaskManager
// callback: no React, no Zustand, no auth client, no browser storage, no DOM.
// `headlessBoundary.test.ts` bundles this barrel and fails on any of those, and
// `pnpm mobile:bundle:check` repeats the check against the real Metro graph.

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
export { formatIncidentAnnouncement } from "./incidentAnnounce";
export {
  type IncidentAlert,
  type ProjectEventsOptions,
  projectEventsToRoute,
} from "./incidentProjection";
export { guidanceApproachMeters, resolveRecommendedLanes, shouldPreviewNextStep } from "./lanes";
export { isLiveNavigationStatus } from "./liveStatus";
export {
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
  migrateMobileSession,
  mobileNavigationSessionSchema,
  mobileTerminalAckSchema,
  parseMobileSession,
  type RedactedSession,
  redactSessionForDiagnostics,
  type SessionParseResult,
  type TransitMobileSession,
} from "./mobileSession";
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
  type TransitConfidence,
  type TransitNavigationEvent,
  type TransitPhase,
  type TransitTickInput,
  type TransitTickOptions,
  type TransitTickResult,
  type TransitTickState,
} from "./processTransitFix";
export { computeProgress, upcomingManeuverIndex } from "./progress";
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
  type AlongRouteOptions,
  type AlongRoutePoi,
  DEFAULT_CORRIDOR_PAD_METERS,
  PROGRESS_BUCKET_METERS,
  paddedRouteAheadBounds,
  poiAlongRoute,
  progressBucket,
  progressBucketStartMeters,
  routeAheadBounds,
} from "./searchAlongRoute";
export { simulatePositions } from "./simulatePositions";
export { snapToRoute } from "./snap";
export { isOverSpeed, OVER_SPEED_TOLERANCE_KMH } from "./speedAlert";
export { matchSpeedLimitsByPoint, pickSpeedLimit } from "./speedLimits";
export {
  extractTrafficSignals,
  type GeometryWindow,
  signalCoordKey,
  windowGeometry,
} from "./trafficSignals";
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
  computeTransitProgress,
  detectMissedConnection,
  type PreparedTransitProgress,
  prepareTransitProgress,
  stopsUntilAlight,
  type TransitProgress,
} from "./transitProgress";
export {
  type CapturableLeg,
  captureTransitLegStops,
  type JourneyStopLike,
  sliceJourneyToLeg,
} from "./transitStops";
export {
  composeWalkInstruction,
  type TransitWalkManeuver,
  type WalkStepInfo,
  walkLegStepProgress,
  walkStepInfo,
} from "./transitWalk";
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
