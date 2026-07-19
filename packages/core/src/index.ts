// Public barrel. Add new exports to the per-folder sub-barrels
// (src/<folder>/index.ts), not to this file. The `./navigation` and
// `./git-url` blocks stay explicit: navigation curates a subset of its
// folder and git-url is a single file whose node-only siblings live in
// `./server`.
export * from "./api";
export * from "./auth";
export * from "./constants";
export * from "./domains";

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
  brakingDistanceMeters,
  CAMERA_RESTRICTED_COUNTRIES,
  type CoastOptions,
  type CoastResult,
  coastState,
  computeProgress,
  computeTransitProgress,
  cumulativeDistances,
  type DeadReckonOptions,
  type DeadReckonTarget,
  detectMissedConnection,
  eta,
  extractTimeline,
  extractTrafficSignals,
  formatIncidentAnnouncement,
  freshNavTickState,
  type GeometryWindow,
  guidanceApproachMeters,
  type IncidentAlert,
  isOverSpeed,
  isReroutingTooOften,
  matchSpeedLimitsByPoint,
  NAV_RECORDING_VERSION,
  type NavRecording,
  navOptionsForMode,
  nextVoiceCue,
  OVER_SPEED_TOLERANCE_KMH,
  type ProjectEventsOptions,
  pickSpeedLimit,
  poiAlongRoute,
  positionAt,
  processFix,
  projectEventsToRoute,
  pruneRerouteTimes,
  type RecordedReroute,
  type ReplayStep,
  type RoadAlert,
  type RoadAlertType,
  remainingWaypoints,
  replayRecording,
  resolveRecommendedLanes,
  routeAheadBounds,
  SIGNAL_LOST_GAP_MS,
  selectActiveAlert,
  shouldPreviewNextStep,
  shouldReroute,
  shouldRerouteForClosure,
  shouldWarnCamera,
  signalCoordKey,
  simulatePositions,
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
export * from "./panels";
export * from "./platform";
export * from "./stores";
export * from "./types";
export * from "./utils";
