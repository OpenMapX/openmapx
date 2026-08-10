import * as Location from "expo-location";
import { Platform } from "react-native";
import { ANDROID_FOREGROUND_SERVICE_COPY, type MobileLocale } from "../../config/nativeCopy";
import { NAVIGATION_LOCATION_TASK } from "../background/taskName";
import type { LocationDriver, LocationPermissionState, LocationProfile } from "./LocationDriver";

/**
 * The provisionally selected `LocationDriver`.
 *
 * Chosen from Expo's documented contract, automated lifecycle tests, clean
 * release builds and simulator smoke runs — not from physical-device evidence,
 * which is deferred to the volunteer store beta. If the same driver-specific
 * background failure reproduces twice there, this file is the only one replaced.
 */

function mapAccuracy(profile: LocationProfile): Location.LocationAccuracy {
  return profile.accuracy === "navigation"
    ? Location.LocationAccuracy.BestForNavigation
    : Location.LocationAccuracy.High;
}

function mapActivityType(profile: LocationProfile): Location.LocationActivityType {
  switch (profile.activityType) {
    case "automotive-navigation":
      return Location.LocationActivityType.AutomotiveNavigation;
    case "fitness":
      return Location.LocationActivityType.Fitness;
    case "other-navigation":
      return Location.LocationActivityType.OtherNavigation;
  }
}

/**
 * Collapses Expo's separate foreground/background permission responses into the
 * single state the coordinator reasons about.
 */
export function combinePermissionState(
  foreground: { granted: boolean; canAskAgain: boolean; status: string },
  background: { granted: boolean } | null,
): LocationPermissionState {
  if (!foreground.granted) {
    if (foreground.status === "undetermined") return "not-determined";
    return "denied";
  }
  if (background?.granted) return "background";
  return "foreground";
}

export class ExpoLocationDriver implements LocationDriver {
  /**
   * Serialises every start/stop. `startLocationUpdatesAsync` is not safe to
   * interleave: two concurrent starts can register two streams whose callbacks
   * then double-count every fix.
   */
  private queue: Promise<unknown> = Promise.resolve();
  private activeProfile: LocationProfile | null = null;

  constructor(private readonly locale: MobileLocale = "en") {}

  private serialise<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    // Keep the chain alive after a rejection so one failure cannot wedge the
    // driver permanently.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async getPermissionState(): Promise<LocationPermissionState> {
    const foreground = await Location.getForegroundPermissionsAsync();
    if (!foreground.granted) return combinePermissionState(foreground, null);
    const background = await Location.getBackgroundPermissionsAsync();
    return combinePermissionState(foreground, background);
  }

  async requestForegroundPermission(): Promise<LocationPermissionState> {
    const foreground = await Location.requestForegroundPermissionsAsync();
    return combinePermissionState(foreground, null);
  }

  async requestBackgroundPermission(): Promise<LocationPermissionState> {
    const foreground = await Location.getForegroundPermissionsAsync();
    // Requesting Always before a granted When-In-Use is silently denied on iOS,
    // so the caller is told to complete the foreground step first.
    if (!foreground.granted) return combinePermissionState(foreground, null);
    const background = await Location.requestBackgroundPermissionsAsync();
    return combinePermissionState(foreground, background);
  }

  async isRunning(): Promise<boolean> {
    return Location.hasStartedLocationUpdatesAsync(NAVIGATION_LOCATION_TASK);
  }

  async start(profile: LocationProfile): Promise<void> {
    await this.serialise(async () => {
      const running = await Location.hasStartedLocationUpdatesAsync(NAVIGATION_LOCATION_TASK);
      if (running) {
        if (this.sameProfile(profile)) return;
        // A profile change replaces the stream rather than adding one.
        await Location.stopLocationUpdatesAsync(NAVIGATION_LOCATION_TASK);
      }
      await Location.startLocationUpdatesAsync(NAVIGATION_LOCATION_TASK, {
        accuracy: mapAccuracy(profile),
        timeInterval: profile.timeIntervalMs,
        distanceInterval: profile.distanceIntervalMeters,
        activityType: mapActivityType(profile),
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
        // Deferred updates are deliberately not requested: they can delay a cue,
        // and no device evidence yet exists that they are safe here.
        ...(Platform.OS === "android"
          ? {
              foregroundService: {
                notificationTitle: ANDROID_FOREGROUND_SERVICE_COPY[this.locale].notificationTitle,
                notificationBody: ANDROID_FOREGROUND_SERVICE_COPY[this.locale].notificationBody,
                notificationColor: "#1B69D6",
                killServiceOnDestroy: false,
              },
            }
          : {}),
      });
      this.activeProfile = profile;
    });
  }

  async stop(): Promise<void> {
    await this.serialise(async () => {
      const running = await Location.hasStartedLocationUpdatesAsync(NAVIGATION_LOCATION_TASK);
      if (running) await Location.stopLocationUpdatesAsync(NAVIGATION_LOCATION_TASK);
      this.activeProfile = null;
    });
  }

  private sameProfile(profile: LocationProfile): boolean {
    const active = this.activeProfile;
    return (
      active !== null &&
      active.accuracy === profile.accuracy &&
      active.timeIntervalMs === profile.timeIntervalMs &&
      active.distanceIntervalMeters === profile.distanceIntervalMeters &&
      active.activityType === profile.activityType
    );
  }
}
