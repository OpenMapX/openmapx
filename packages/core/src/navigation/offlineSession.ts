import type { NavigationRouteOptions, RouteSelectionIntent } from "../stores/navigationStore";
import type { LngLat } from "../types/geometry";
import type { ManeuverLane, ManeuverSign, Route, RouteLeg, RouteStep } from "../types/routing";
import type { NavProgress } from "./types";

/** Hard compatibility gate for route sessions stored by the browser. */
export const NAVIGATION_SESSION_SCHEMA_VERSION = 1 as const;
export const NAVIGATION_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const GROUND_MODES = new Set<Route["mode"]>(["driving", "walking", "cycling", "motorcycle"]);

export interface NavigationSessionSnapshot {
  schemaVersion: 1;
  kind: "ground";
  route: Route;
  routes: Route[];
  activeRouteIndex: number;
  routeSelectionIntent: RouteSelectionIntent;
  mode: Extract<Route["mode"], "driving" | "walking" | "cycling" | "motorcycle">;
  routeOptions: NavigationRouteOptions;
  routeProvider: string | null;
  destinationWaypoints: LngLat[];
  progress: NavProgress | null;
  packageIds: string[];
  startedAtMs: number;
  updatedAtMs: number;
  lastKnownPosition?: {
    coords: LngLat;
    timestampMs: number;
  };
  /** Stable identity for the route/session, useful for diagnostics and UI. */
  routeFingerprint: string;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isLngLat(value: unknown): value is LngLat {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isFiniteNumber(value[0]) &&
    isFiniteNumber(value[1]) &&
    value[0] >= -180 &&
    value[0] <= 180 &&
    value[1] >= -90 &&
    value[1] <= 90
  );
}

function copyLngLat(value: LngLat): LngLat {
  return [value[0], value[1]];
}

function copyStep(step: RouteStep): RouteStep {
  return {
    instruction: step.instruction,
    distance: step.distance,
    duration: step.duration,
    coordinates: step.coordinates.map(copyLngLat),
    ...(step.roadNames && { roadNames: [...step.roadNames] }),
    ...(step.maneuver && { maneuver: { ...step.maneuver } }),
    ...(step.speedLimit !== undefined && { speedLimit: step.speedLimit }),
    ...(step.lanes && {
      lanes: step.lanes.map((lane) => ({
        indications: [...lane.indications],
        valid: lane.valid,
        ...(lane.active !== undefined && { active: lane.active }),
      })),
    }),
    ...(step.verbalAlert !== undefined && { verbalAlert: step.verbalAlert }),
    ...(step.verbalPre !== undefined && { verbalPre: step.verbalPre }),
    ...(step.verbalPost !== undefined && { verbalPost: step.verbalPost }),
    ...(step.verbalSuccinct !== undefined && { verbalSuccinct: step.verbalSuccinct }),
    ...(step.roundaboutExitCount !== undefined && {
      roundaboutExitCount: step.roundaboutExitCount,
    }),
    ...(step.sign && {
      sign: {
        ...(step.sign.exitNumbers && { exitNumbers: [...step.sign.exitNumbers] }),
        ...(step.sign.exitBranches && { exitBranches: [...step.sign.exitBranches] }),
        ...(step.sign.exitToward && { exitToward: [...step.sign.exitToward] }),
        ...(step.sign.exitNames && { exitNames: [...step.sign.exitNames] }),
      },
    }),
    ...(step.drivingSide !== undefined && { drivingSide: step.drivingSide }),
  };
}

function copyLeg(leg: RouteLeg): RouteLeg {
  return {
    distance: leg.distance,
    duration: leg.duration,
    geometry: leg.geometry.map(copyLngLat),
    steps: leg.steps.map(copyStep),
    ...(leg.summary !== undefined && { summary: leg.summary }),
  };
}

function copyRoute(route: Route): Route {
  return {
    distance: route.distance,
    duration: route.duration,
    ...(route.baselineDuration !== undefined && { baselineDuration: route.baselineDuration }),
    geometry: route.geometry.map(copyLngLat),
    legs: route.legs.map(copyLeg),
    steps: route.steps.map(copyStep),
    mode: route.mode,
    ...(route.segmentSpeedLimits && { segmentSpeedLimits: [...route.segmentSpeedLimits] }),
    ...(route.summary !== undefined && { summary: route.summary }),
    ...(route.elevation && { elevation: [...route.elevation] }),
    ...(route.elevationInterval !== undefined && { elevationInterval: route.elevationInterval }),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function validateManeuver(value: unknown): value is NonNullable<RouteStep["maneuver"]> {
  if (!isPlainObject(value)) return false;
  return typeof value.type === "string" && isOptionalString(value.modifier);
}

function validateLanes(value: unknown): value is ManeuverLane[] {
  return (
    Array.isArray(value) &&
    value.every(
      (lane) =>
        isPlainObject(lane) &&
        isStringArray(lane.indications) &&
        typeof lane.valid === "boolean" &&
        isOptionalString(lane.active),
    )
  );
}

function validateSign(value: unknown): value is ManeuverSign {
  if (!isPlainObject(value)) return false;
  return [value.exitNumbers, value.exitBranches, value.exitToward, value.exitNames].every(
    // The copy drops falsy entries, so only present values have to be arrays.
    (entry) => !entry || isStringArray(entry),
  );
}

function validateStep(step: unknown): step is RouteStep {
  if (!step || typeof step !== "object") return false;
  const value = step as RouteStep;
  if (
    typeof value.instruction !== "string" ||
    !isFiniteNumber(value.distance) ||
    value.distance < 0 ||
    !isFiniteNumber(value.duration) ||
    value.duration < 0 ||
    !Array.isArray(value.coordinates) ||
    value.coordinates.length === 0 ||
    !value.coordinates.every(isLngLat)
  ) {
    return false;
  }
  if (
    value.speedLimit !== undefined &&
    (!isFiniteNumber(value.speedLimit) || value.speedLimit < 0)
  ) {
    return false;
  }
  if (
    value.roundaboutExitCount !== undefined &&
    (!Number.isInteger(value.roundaboutExitCount) || value.roundaboutExitCount < 1)
  ) {
    return false;
  }
  // Every optional container below is spread, mapped or read field by field by
  // `copyStep`, so its shape has to hold before the copy can touch it.
  if (value.roadNames && !isStringArray(value.roadNames)) return false;
  if (value.maneuver && !validateManeuver(value.maneuver)) return false;
  if (value.lanes && !validateLanes(value.lanes)) return false;
  if (value.sign && !validateSign(value.sign)) return false;
  if (
    ![value.verbalAlert, value.verbalPre, value.verbalPost, value.verbalSuccinct].every(
      isOptionalString,
    )
  ) {
    return false;
  }
  if (
    value.drivingSide !== undefined &&
    value.drivingSide !== "left" &&
    value.drivingSide !== "right"
  ) {
    return false;
  }
  return true;
}

function validateLeg(leg: unknown): leg is RouteLeg {
  if (!leg || typeof leg !== "object") return false;
  const value = leg as RouteLeg;
  return (
    isFiniteNumber(value.distance) &&
    value.distance >= 0 &&
    isFiniteNumber(value.duration) &&
    value.duration >= 0 &&
    Array.isArray(value.geometry) &&
    value.geometry.length >= 2 &&
    value.geometry.every(isLngLat) &&
    Array.isArray(value.steps) &&
    value.steps.every(validateStep) &&
    isOptionalString(value.summary)
  );
}

function validateRoute(value: unknown): value is Route {
  if (!value || typeof value !== "object") return false;
  const route = value as Route;
  if (
    !GROUND_MODES.has(route.mode) ||
    !isFiniteNumber(route.distance) ||
    route.distance < 0 ||
    !isFiniteNumber(route.duration) ||
    route.duration < 0 ||
    !Array.isArray(route.geometry) ||
    route.geometry.length < 2 ||
    !route.geometry.every(isLngLat) ||
    !Array.isArray(route.legs) ||
    !Array.isArray(route.steps) ||
    route.steps.length === 0 ||
    !route.steps.every(validateStep)
  ) {
    return false;
  }
  if (!route.legs.every(validateLeg)) return false;
  if (
    route.segmentSpeedLimits &&
    (!Array.isArray(route.segmentSpeedLimits) ||
      route.segmentSpeedLimits.length !== route.geometry.length - 1 ||
      !route.segmentSpeedLimits.every(
        (limit) => limit === null || (isFiniteNumber(limit) && limit >= 0),
      ))
  ) {
    return false;
  }
  if (
    route.baselineDuration !== undefined &&
    (!isFiniteNumber(route.baselineDuration) || route.baselineDuration < 0)
  ) {
    return false;
  }
  if (!isOptionalString(route.summary)) return false;
  if (
    route.elevation &&
    (!Array.isArray(route.elevation) || !route.elevation.every(isFiniteNumber))
  )
    return false;
  if (route.elevationInterval !== undefined && !isFiniteNumber(route.elevationInterval)) {
    return false;
  }
  return true;
}

function validateProgress(value: unknown): value is NavProgress | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const progress = value as NavProgress;
  return (
    Number.isInteger(progress.currentStepIndex) &&
    progress.currentStepIndex >= 0 &&
    isFiniteNumber(progress.distanceToNextManeuver) &&
    progress.distanceToNextManeuver >= 0 &&
    isFiniteNumber(progress.distanceRemaining) &&
    progress.distanceRemaining >= 0 &&
    isFiniteNumber(progress.durationRemaining) &&
    progress.durationRemaining >= 0 &&
    isLngLat(progress.snapped) &&
    isFiniteNumber(progress.alongMeters) &&
    progress.alongMeters >= 0 &&
    isFiniteNumber(progress.deviationMeters) &&
    progress.deviationMeters >= 0 &&
    Number.isInteger(progress.segmentIndex) &&
    progress.segmentIndex >= 0 &&
    isFiniteNumber(progress.etaEpochMs) &&
    isFiniteNumber(progress.bearing) &&
    isFiniteNumber(progress.speedMps) &&
    progress.speedMps >= 0
  );
}

function validateRouteOptions(value: unknown): value is NavigationRouteOptions {
  if (!value || typeof value !== "object") return false;
  const options = value as NavigationRouteOptions;
  return [
    options.avoidHighways,
    options.avoidTolls,
    options.avoidFerries,
    options.avoidClosures,
  ].every((entry) => typeof entry === "boolean");
}

function equivalentRoute(a: Route, b: Route): boolean {
  return JSON.stringify(copyRoute(a)) === JSON.stringify(copyRoute(b));
}

function validatePackageId(value: unknown): value is string {
  return typeof value === "string" && /^omp2-[0-9a-f]{64}$/.test(value);
}

function validateSnapshot(value: unknown): value is NavigationSessionSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as NavigationSessionSnapshot;
  if (
    snapshot.schemaVersion !== NAVIGATION_SESSION_SCHEMA_VERSION ||
    snapshot.kind !== "ground" ||
    !GROUND_MODES.has(snapshot.mode) ||
    !validateRoute(snapshot.route) ||
    !Array.isArray(snapshot.routes) ||
    snapshot.routes.length === 0 ||
    !snapshot.routes.every(validateRoute) ||
    !Number.isInteger(snapshot.activeRouteIndex) ||
    snapshot.activeRouteIndex < 0 ||
    snapshot.activeRouteIndex >= snapshot.routes.length ||
    !equivalentRoute(snapshot.routes[snapshot.activeRouteIndex], snapshot.route) ||
    (snapshot.routeSelectionIntent !== "automatic" &&
      snapshot.routeSelectionIntent !== "userSelected") ||
    !validateRouteOptions(snapshot.routeOptions) ||
    (snapshot.routeProvider !== null && typeof snapshot.routeProvider !== "string") ||
    !Array.isArray(snapshot.destinationWaypoints) ||
    !snapshot.destinationWaypoints.every(isLngLat) ||
    !validateProgress(snapshot.progress) ||
    !Array.isArray(snapshot.packageIds) ||
    !snapshot.packageIds.every(validatePackageId) ||
    !isFiniteNumber(snapshot.startedAtMs) ||
    !isFiniteNumber(snapshot.updatedAtMs) ||
    snapshot.updatedAtMs < snapshot.startedAtMs ||
    typeof snapshot.routeFingerprint !== "string" ||
    snapshot.routeFingerprint.length === 0
  ) {
    return false;
  }
  if (
    snapshot.lastKnownPosition &&
    (!isLngLat(snapshot.lastKnownPosition.coords) ||
      !isFiniteNumber(snapshot.lastKnownPosition.timestampMs))
  ) {
    return false;
  }
  return true;
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function stableHash(input: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function navigationSessionFingerprint(
  snapshot: Pick<
    NavigationSessionSnapshot,
    "route" | "destinationWaypoints" | "mode" | "routeProvider"
  >,
): string {
  const canonical = {
    geometry: snapshot.route.geometry.map(([lng, lat]) => [rounded(lng), rounded(lat)]),
    destinationWaypoints: snapshot.destinationWaypoints.map(([lng, lat]) => [
      rounded(lng),
      rounded(lat),
    ]),
    mode: snapshot.mode,
    provider: snapshot.routeProvider,
  };
  return `nav1-${stableHash(JSON.stringify(canonical))}`;
}

export function createNavigationSessionSnapshot(input: {
  route: Route;
  routes: Route[];
  activeRouteIndex: number;
  routeSelectionIntent: RouteSelectionIntent;
  mode: Extract<Route["mode"], "driving" | "walking" | "cycling" | "motorcycle">;
  routeOptions: NavigationRouteOptions;
  routeProvider: string | null;
  destinationWaypoints: LngLat[];
  progress: NavProgress | null;
  packageIds: string[];
  startedAtMs: number;
  updatedAtMs: number;
  lastKnownPosition?: { coords: LngLat; timestampMs: number };
}): NavigationSessionSnapshot {
  const snapshot = buildSnapshot(input);
  snapshot.routeFingerprint = navigationSessionFingerprint(snapshot);
  if (!validateRoute(snapshot.route) || !validateSnapshot(snapshot)) {
    throw new Error("cannot create an invalid navigation session snapshot");
  }
  return snapshot;
}

function buildSnapshot(input: Parameters<typeof createNavigationSessionSnapshot>[0]) {
  try {
    return copySnapshotFields(input);
  } catch {
    // Copying reads nested containers directly. Input that is not shaped like a
    // route at all fails here rather than at validation; both mean the same
    // thing to callers, so report the single documented failure.
    throw new Error("cannot create an invalid navigation session snapshot");
  }
}

function copySnapshotFields(input: Parameters<typeof createNavigationSessionSnapshot>[0]) {
  return {
    schemaVersion: NAVIGATION_SESSION_SCHEMA_VERSION,
    kind: "ground" as const,
    route: copyRoute(input.route),
    routes: input.routes.map(copyRoute),
    activeRouteIndex: input.activeRouteIndex,
    routeSelectionIntent: input.routeSelectionIntent,
    mode: input.mode,
    routeOptions: { ...input.routeOptions },
    routeProvider: input.routeProvider,
    destinationWaypoints: input.destinationWaypoints.map(copyLngLat),
    progress: input.progress
      ? {
          ...input.progress,
          snapped: copyLngLat(input.progress.snapped),
        }
      : null,
    packageIds: [...input.packageIds],
    startedAtMs: input.startedAtMs,
    updatedAtMs: input.updatedAtMs,
    ...(input.lastKnownPosition && {
      lastKnownPosition: {
        coords: copyLngLat(input.lastKnownPosition.coords),
        timestampMs: input.lastKnownPosition.timestampMs,
      },
    }),
    routeFingerprint: "",
  } satisfies NavigationSessionSnapshot;
}

/**
 * Total parse boundary: arbitrary IndexedDB input either produces a fully
 * validated, freshly copied snapshot or `null`. It never throws, so a corrupt
 * record is always clearable rather than fatal to the page that read it.
 */
export function parseNavigationSessionSnapshot(value: unknown): NavigationSessionSnapshot | null {
  try {
    return parseValidatedSnapshot(value);
  } catch {
    return null;
  }
}

function parseValidatedSnapshot(value: unknown): NavigationSessionSnapshot | null {
  if (!validateSnapshot(value)) return null;
  const route = copyRoute(value.route);
  const routes = value.routes.map(copyRoute);
  const snapshot: NavigationSessionSnapshot = {
    ...value,
    route,
    routes,
    routeOptions: { ...value.routeOptions },
    destinationWaypoints: value.destinationWaypoints.map(copyLngLat),
    progress: value.progress
      ? { ...value.progress, snapped: copyLngLat(value.progress.snapped) }
      : null,
    packageIds: [...value.packageIds],
    ...(value.lastKnownPosition && {
      lastKnownPosition: {
        coords: copyLngLat(value.lastKnownPosition.coords),
        timestampMs: value.lastKnownPosition.timestampMs,
      },
    }),
  };
  if (!equivalentRoute(snapshot.routes[snapshot.activeRouteIndex], snapshot.route)) {
    snapshot.routes[snapshot.activeRouteIndex] = snapshot.route;
  }
  if (snapshot.routeFingerprint !== navigationSessionFingerprint(snapshot)) return null;
  return snapshot;
}

export function isNavigationSessionExpired(
  snapshot: NavigationSessionSnapshot,
  nowMs: number,
): boolean {
  return !isFiniteNumber(nowMs) || nowMs - snapshot.updatedAtMs > NAVIGATION_SESSION_MAX_AGE_MS;
}
