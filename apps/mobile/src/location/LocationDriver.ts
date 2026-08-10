/**
 * The boundary between the navigation coordinator and whatever actually
 * produces location fixes.
 *
 * Nothing above this interface knows that Expo exists. `expo-location` is the
 * provisionally selected implementation; if volunteer-beta evidence reproduces
 * a driver-specific background failure twice, only this one implementation is
 * replaced by a project-owned native module. The coordinator, persistence,
 * bridge, web UI and pure engines stay untouched.
 *
 * Expo types never appear here — leaking them would make that swap a rewrite.
 */

export type LocationPermissionState =
  | "not-determined"
  | "foreground"
  | "background"
  | "denied"
  | "limited";

export interface LocationProfile {
  accuracy: "high" | "navigation";
  timeIntervalMs: number;
  distanceIntervalMeters: number;
  activityType: "automotive-navigation" | "fitness" | "other-navigation";
  /**
   * Always false. iOS pausing an active navigation session's updates is
   * indistinguishable from the app being broken, so it is never requested.
   */
  pausesUpdatesAutomatically: false;
}

/** A single accepted position, in the neutral shape the shared engines use. */
export interface LocationFix {
  /** `[longitude, latitude]`, matching the shared navigation engine. */
  coords: [number, number];
  /** Horizontal accuracy in metres. */
  accuracy: number;
  timestampMs: number;
  speedMps?: number;
  headingDegrees?: number;
  altitudeMeters?: number;
}

/** What a one-shot foreground request is allowed to ask for. */
export interface CurrentFixOptions {
  accuracy: "balanced" | "precise";
  timeoutMs: number;
  /** A known fix younger than this satisfies the request without a new read. */
  maxAgeMs: number;
}

export interface LocationDriver {
  getPermissionState(): Promise<LocationPermissionState>;
  requestForegroundPermission(): Promise<LocationPermissionState>;
  requestBackgroundPermission(): Promise<LocationPermissionState>;
  start(profile: LocationProfile): Promise<void>;
  stop(): Promise<void>;
  isRunning(): Promise<boolean>;
  /**
   * One position, for an ordinary foreground action like "centre on me".
   *
   * Deliberately not a stream and deliberately not a permission escalation:
   * these are map gestures, not navigation, and asking for background location
   * to satisfy one would be both wrong and a review finding.
   */
  getCurrentFix(options: CurrentFixOptions): Promise<LocationFix | null>;
}
