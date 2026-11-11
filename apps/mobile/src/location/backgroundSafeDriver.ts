import type { LocationDriver } from "./LocationDriver";

/** Whether the user is looking at the app, and when they come back to it. */
export interface AppActivity {
  isActive(): boolean;
  /** Calls `listener` on each transition to active; returns an unsubscribe. */
  onActive(listener: () => void): () => void;
}

/**
 * Keeps a running Android location stream alive across profile changes the
 * platform would refuse.
 *
 * expo-location changes a profile by stopping the stream and starting it again.
 * Starting it starts the location foreground service. Android 12 and later
 * forbid starting a foreground service from the background, and expo-location
 * enforces this itself on every Android version: it throws
 * `ForegroundServiceStartNotAllowedException` unless its activity is in the
 * foreground, and a locked screen or a headless process does not count. The
 * stop has already succeeded by then, so a cadence change with the phone in a
 * pocket (cruising to near-event before the alighting stop) used to end
 * tracking altogether.
 *
 * So on Android a running stream is never restarted while the app is not
 * active: the driver asks inside its serialized step, immediately before the
 * stop, and keeps the stream at its current cadence if the answer is no.
 * Nothing is remembered here. A runtime the system starts for one batch is torn
 * down seconds later, so the cadence the session wants is derived again from
 * the committed session when the app next becomes active (see
 * `NavigationCoordinator.refreshLocationProfile`). Starting a stream that is not
 * running, and stopping one, are passed straight through. iOS changes profiles
 * in the background without a service, so it is not wrapped.
 */
export function withBackgroundSafeProfiles(
  driver: LocationDriver,
  os: "ios" | "android",
  activity: Pick<AppActivity, "isActive">,
): LocationDriver {
  if (os !== "android") return driver;
  return {
    ...(driver.setLocale ? { setLocale: (locale) => driver.setLocale?.(locale) } : {}),
    getPermissionState: () => driver.getPermissionState(),
    requestForegroundPermission: () => driver.requestForegroundPermission(),
    requestBackgroundPermission: () => driver.requestBackgroundPermission(),
    start: (profile, options = {}) =>
      driver.start(profile, {
        mayRestart: () => activity.isActive() && (options.mayRestart?.() ?? true),
      }),
    stop: () => driver.stop(),
    isRunning: () => driver.isRunning(),
    getCurrentFix: (options) => driver.getCurrentFix(options),
  };
}
