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

export interface LocationDriver {
  getPermissionState(): Promise<LocationPermissionState>;
  requestForegroundPermission(): Promise<LocationPermissionState>;
  requestBackgroundPermission(): Promise<LocationPermissionState>;
  start(profile: LocationProfile): Promise<void>;
  stop(): Promise<void>;
  isRunning(): Promise<boolean>;
}
