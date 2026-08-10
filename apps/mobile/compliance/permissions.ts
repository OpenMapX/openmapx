/**
 * The exact protected capabilities this app is allowed to ship.
 *
 * Stated positively — the complete permitted set, not a list of things to avoid
 * — because an allowlist fails closed and a denylist fails open. A dependency
 * that starts declaring a permission nobody asked for shows up as an *extra*
 * against this set, whereas a denylist only catches the ones somebody thought
 * to write down.
 *
 * Every entry names the practice row that justifies it. A permission with no
 * justification is a permission that will be asked about in review, and the
 * answer needs to exist before then rather than be improvised.
 */

export interface PermissionEntry {
  /** The platform identifier as it appears in the manifest or Info.plist. */
  id: string;
  /** The data-practice row that justifies it. */
  practiceId: string;
  reason: string;
}

export const IOS_USAGE_DESCRIPTION_KEYS: PermissionEntry[] = [
  {
    id: "NSLocationWhenInUseUsageDescription",
    practiceId: "precise-location-active-navigation",
    reason: "Following the route while the app is open.",
  },
  {
    id: "NSLocationAlwaysAndWhenInUseUsageDescription",
    practiceId: "background-location-active-navigation",
    reason: "Continuing the same guidance with the screen locked.",
  },
];

export const IOS_BACKGROUND_MODES: PermissionEntry[] = [
  {
    id: "location",
    practiceId: "background-location-active-navigation",
    reason:
      "The only background mode. `audio` stays undeclared unless volunteer-beta evidence proves spoken guidance needs it — declaring a mode the app does not demonstrably require is a review finding.",
  },
];

export const ANDROID_PERMISSIONS: PermissionEntry[] = [
  {
    id: "android.permission.INTERNET",
    practiceId: "route-request-coordinates",
    reason: "The product UI is served over the network.",
  },
  {
    id: "android.permission.ACCESS_COARSE_LOCATION",
    practiceId: "precise-location-active-navigation",
    reason: "Requested alongside fine location, as Android requires.",
  },
  {
    id: "android.permission.ACCESS_FINE_LOCATION",
    practiceId: "precise-location-active-navigation",
    reason: "Turn-by-turn guidance needs a precise position.",
  },
  {
    id: "android.permission.ACCESS_BACKGROUND_LOCATION",
    practiceId: "background-location-active-navigation",
    reason: "Guidance continues with the screen locked.",
  },
  {
    id: "android.permission.FOREGROUND_SERVICE",
    practiceId: "background-location-active-navigation",
    reason: "The location service that keeps the session alive.",
  },
  {
    id: "android.permission.FOREGROUND_SERVICE_LOCATION",
    practiceId: "background-location-active-navigation",
    reason: "The typed foreground-service declaration Android 14+ requires.",
  },
  {
    id: "android.permission.POST_NOTIFICATIONS",
    practiceId: "local-alerts",
    reason: "The transit get-off alert, and the foreground-service notification.",
  },
  {
    id: "android.permission.VIBRATE",
    practiceId: "local-alerts",
    reason:
      "The get-off alert vibrates, which is the part a rider notices with the phone in a pocket. Not a dangerous permission and not runtime-requested.",
  },
];

/**
 * Capabilities that must be absent, and why each would be a problem.
 *
 * Redundant with the allowlist by construction, and kept anyway: the message a
 * failing check prints is the useful artefact, and "RECORD_AUDIO is present"
 * says much less than the reason it must not be.
 */
export const FORBIDDEN_ANDROID_PERMISSIONS: Record<string, string> = {
  "android.permission.RECORD_AUDIO": "The shell has no microphone feature and declares none.",
  "android.permission.CAMERA": "The shell has no camera feature.",
  "android.permission.READ_CONTACTS": "Never requested.",
  "android.permission.READ_CALENDAR": "Never requested.",
  "android.permission.READ_PHONE_STATE": "Never requested.",
  "android.permission.READ_SMS": "Never requested.",
  "android.permission.BLUETOOTH_SCAN": "Nearby-device scanning is a location side channel.",
  "com.google.android.gms.permission.AD_ID": "There is no advertising identifier and no tracking.",
  "android.permission.QUERY_ALL_PACKAGES": "Broad package visibility is sensitive and unnecessary.",
  "android.permission.READ_EXTERNAL_STORAGE": "The app reads no user files.",
  "android.permission.WRITE_EXTERNAL_STORAGE": "The app writes no user files.",
  "android.permission.READ_MEDIA_IMAGES": "The app reads no photos.",
  "android.permission.READ_MEDIA_VIDEO": "The app reads no videos.",
  "android.permission.READ_MEDIA_AUDIO": "The app reads no audio files.",
  "android.permission.RECEIVE_BOOT_COMPLETED": "Nothing starts at boot.",
  "android.permission.SYSTEM_ALERT_WINDOW": "The app draws over nothing.",
  "android.permission.BIND_VPN_SERVICE": "The app is not a VPN.",
  "android.permission.BIND_ACCESSIBILITY_SERVICE": "The app is not an accessibility service.",
  "android.permission.SCHEDULE_EXACT_ALARM":
    "Alerts are scheduled by the notification system, not by exact alarms.",
  "android.permission.USE_EXACT_ALARM": "Same as above.",
  "com.google.android.c2dm.permission.RECEIVE": "There is no remote push.",
  "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK":
    "Spoken guidance is not media playback, and claiming it would be a second, untrue justification for running in the background.",
};

export const FORBIDDEN_IOS_KEYS: Record<string, string> = {
  NSMicrophoneUsageDescription: "The shell has no microphone feature.",
  NSCameraUsageDescription: "The shell has no camera feature.",
  NSContactsUsageDescription: "Never requested.",
  NSCalendarsUsageDescription: "Never requested.",
  NSPhotoLibraryUsageDescription: "Never requested.",
  NSUserTrackingUsageDescription: "There is no tracking to ask permission for.",
  NSBluetoothAlwaysUsageDescription: "Never requested.",
};

export const FORBIDDEN_IOS_BACKGROUND_MODES: Record<string, string> = {
  audio: "Undeclared until volunteer-beta evidence proves spoken guidance needs it.",
  fetch: "There is no background fetch.",
  "remote-notification": "There is no remote push.",
  processing: "There is no background processing task.",
};

export interface PermissionSurface {
  iosUsageDescriptionKeys: string[];
  iosBackgroundModes: string[];
  androidPermissions: string[];
}

/** The complete permitted surface, as bare identifiers. */
export function expectedPermissionSurface(): PermissionSurface {
  return {
    iosUsageDescriptionKeys: IOS_USAGE_DESCRIPTION_KEYS.map((entry) => entry.id),
    iosBackgroundModes: IOS_BACKGROUND_MODES.map((entry) => entry.id),
    androidPermissions: ANDROID_PERMISSIONS.map((entry) => entry.id),
  };
}

export interface SurfaceViolation {
  platform: "ios" | "android";
  kind: "unexpected" | "missing" | "forbidden";
  id: string;
  reason: string;
}

/**
 * Compares an observed surface against the permitted one.
 *
 * `unexpected` and `forbidden` both mean "this must not ship". They are
 * distinguished because a forbidden entry has a written reason worth printing,
 * while an unexpected one is something nobody has considered at all — which is
 * arguably the more alarming of the two.
 */
export function diffPermissionSurface(observed: Partial<PermissionSurface>): SurfaceViolation[] {
  const expected = expectedPermissionSurface();
  const violations: SurfaceViolation[] = [];

  const compare = (
    platform: "ios" | "android",
    label: string,
    seen: string[] | undefined,
    allowed: string[],
    forbidden: Record<string, string>,
  ) => {
    if (!seen) return;
    for (const id of seen) {
      if (allowed.includes(id)) continue;
      violations.push({
        platform,
        kind: id in forbidden ? "forbidden" : "unexpected",
        id,
        reason: forbidden[id] ?? `${label} is not in the reviewed surface`,
      });
    }
    for (const id of allowed) {
      if (seen.includes(id)) continue;
      violations.push({
        platform,
        kind: "missing",
        id,
        reason: `${label} is required and absent — the app would ask for nothing and guide nobody`,
      });
    }
  };

  compare(
    "ios",
    "usage description",
    observed.iosUsageDescriptionKeys,
    expected.iosUsageDescriptionKeys,
    FORBIDDEN_IOS_KEYS,
  );
  compare(
    "ios",
    "background mode",
    observed.iosBackgroundModes,
    expected.iosBackgroundModes,
    FORBIDDEN_IOS_BACKGROUND_MODES,
  );
  compare(
    "android",
    "permission",
    observed.androidPermissions,
    expected.androidPermissions,
    FORBIDDEN_ANDROID_PERMISSIONS,
  );

  return violations;
}
