// Public barrel. Add new exports to the per-folder sub-barrels
// (src/<folder>/index.ts), not to this file. The `./navigation` and
// `./git-url` blocks stay explicit: navigation curates a subset of its
// folder and git-url is a single file whose node-only siblings live in
// `./server`.
export * from "./api";
export * from "./auth";
export * from "./constants";
export * from "./domains";
export * from "./feed-id";

// Git URL allowlist (shared by community service repos + community integrations).
// The `gitShallowClone*` helpers that use these live in `./server` — they import
// `node:fs` and would break the client bundle if re-exported here.
// `repoPaths`, the `services` namespace, and `spawnWithBufferedLogs` use node:fs
// / node:child_process — they live in `./server`, not this client-reachable barrel.
export { ALLOWED_GIT_HOSTS, assertAllowedGitUrl, InvalidGitUrlError } from "./git-url";
export * from "./hooks";
export {
  type ActiveAlert,
  type AlongRouteOptions,
  type AlongRoutePoi,
  type BuildGroundPackageInput,
  type BuildGroundPackageResult,
  brakingDistanceMeters,
  buildGroundNavigationPackage,
  CAMERA_RESTRICTED_COUNTRIES,
  type CoastOptions,
  type CoastResult,
  coastState,
  computeProgress,
  computeTransitProgress,
  createNavigationSessionSnapshot,
  cumulativeDistances,
  DEFAULT_CORRIDOR_PAD_METERS,
  type DeadReckonOptions,
  type DeadReckonTarget,
  detectMissedConnection,
  eta,
  evaluateFasterRoute,
  extractTimeline,
  extractTrafficSignals,
  FASTER_ROUTE_DEFAULTS,
  type FasterRouteCandidate,
  type FasterRouteEvaluation,
  type FasterRouteOptions,
  flowSeverityRank,
  formatIncidentAnnouncement,
  freshNavTickState,
  type GeometryWindow,
  type GroundNavigationSettings,
  type GroundPackageError,
  groundRouteFingerprint,
  guidanceApproachMeters,
  type IncidentAlert,
  isLiveNavigationStatus,
  isNavigationSessionExpired,
  isOverSpeed,
  isReroutingTooOften,
  matchSpeedLimitsByPoint,
  NAV_RECORDING_VERSION,
  NAVIGATION_SESSION_MAX_AGE_MS,
  NAVIGATION_SESSION_SCHEMA_VERSION,
  type NavigationSessionSnapshot,
  type NavRecording,
  navigationSessionFingerprint,
  navOptionsForMode,
  nextVoiceCue,
  OVER_SPEED_TOLERANCE_KMH,
  PROGRESS_BUCKET_METERS,
  type PreparedRouteMatcher,
  type PreparedTransitProgress,
  type ProjectEventsOptions,
  type ProjectFlowOptions,
  paddedRouteAheadBounds,
  parseNavigationSessionSnapshot,
  pickSpeedLimit,
  poiAlongRoute,
  positionAt,
  prepareRouteMatcher,
  prepareTransitProgress,
  processFix,
  progressBucket,
  progressBucketStartMeters,
  projectEventsToRoute,
  projectFlowToRoute,
  pruneRerouteTimes,
  type RecordedReroute,
  type ReplayStep,
  type RoadAlert,
  type RoadAlertType,
  readRouteMatcherCounters,
  remainingWaypoints,
  replayRecording,
  resetRouteMatcherCounters,
  resolveRecommendedLanes,
  routeAheadBounds,
  routeFingerprint,
  SIGNAL_LOST_GAP_MS,
  selectActiveAlert,
  setRouteMatcherCounting,
  shouldPreviewNextStep,
  shouldReroute,
  shouldRerouteForClosure,
  shouldWarnCamera,
  signalCoordKey,
  simulatePositions,
  snapPreparedRoute,
  snapToRoute,
  stepDeadReckon,
  stopsUntilAlight,
  type TimelineEvent,
  type TimelineEventType,
  upcomingManeuverIndex,
  updateOffRouteScore,
  windowGeometry,
} from "./navigation";
export type { TransitProgress } from "./navigation/transitProgress";
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
} from "./navigation/types";
export * from "./offline";
export * from "./panels";
export * from "./platform";
export * from "./schemas";
export * from "./stores";
export * from "./types";
export * from "./utils";
