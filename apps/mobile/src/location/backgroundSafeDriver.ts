import type { LocationDriver, LocationProfile } from "./LocationDriver";

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
 * So on Android, while the app is not active, a request to change a running
 * stream's profile is remembered instead of applied; the stream carries on at
 * its current cadence, and the latest remembered profile is applied the next
 * time the app becomes active. Starting a stream that is not running, and
 * stopping one, are passed straight through. iOS changes profiles in the
 * background without a service, so it is not wrapped.
 */
export function withBackgroundSafeProfiles(
  driver: LocationDriver,
  os: "ios" | "android",
  activity: AppActivity,
): LocationDriver {
  if (os !== "android") return driver;

  let applied: LocationProfile | null = null;
  let deferred: LocationProfile | null = null;

  const start = async (profile: LocationProfile) => {
    if (!activity.isActive() && (await driver.isRunning())) {
      // The stream already runs at `applied`; asking for it again needs nothing.
      deferred = applied && sameProfile(applied, profile) ? null : profile;
      return;
    }
    deferred = null;
    await driver.start(profile);
    applied = profile;
  };

  activity.onActive(() => {
    const pending = deferred;
    if (!pending) return;
    void (async () => {
      // Stopped meanwhile (the trip ended): nothing to apply it to.
      if (!(await driver.isRunning())) {
        if (deferred === pending) deferred = null;
        return;
      }
      if (deferred !== pending) return;
      await start(pending);
    })().catch(() => undefined);
  });

  return {
    ...(driver.setLocale ? { setLocale: (locale) => driver.setLocale?.(locale) } : {}),
    getPermissionState: () => driver.getPermissionState(),
    requestForegroundPermission: () => driver.requestForegroundPermission(),
    requestBackgroundPermission: () => driver.requestBackgroundPermission(),
    start,
    stop: async () => {
      deferred = null;
      applied = null;
      await driver.stop();
    },
    isRunning: () => driver.isRunning(),
    getCurrentFix: (options) => driver.getCurrentFix(options),
  };
}

function sameProfile(a: LocationProfile, b: LocationProfile): boolean {
  return (
    a.accuracy === b.accuracy &&
    a.timeIntervalMs === b.timeIntervalMs &&
    a.distanceIntervalMeters === b.distanceIntervalMeters &&
    a.activityType === b.activityType
  );
}
