import { THEME_COLORS } from "@openmapx/core/theme";
import type { ExpoConfig } from "expo/config";
// Explicit `.ts` specifiers: Expo's config loader transpiles only this entry
// file, so its imports are resolved by Node, which needs the real extension to
// apply type stripping.
import { readMobileConfig } from "./config/mobileConfig.ts";
import { IOS_USAGE_DESCRIPTIONS } from "./config/nativeCopy.ts";

/**
 * Continuous Native Generation input.
 *
 * Everything the generated Xcode and Gradle projects contain is derived from
 * this file, the local config plugin, and the local Expo modules. `ios/` and
 * `android/` are build output: regenerate them, never edit them.
 */
const mobile = readMobileConfig(process.env);

/**
 * The web UI's primary colour, used for the Android notification tint and the
 * adaptive icon's background, so the app's own surfaces match the page.
 */
const BRAND_COLOR = THEME_COLORS.light.primary;

/**
 * Associated domains exist only when a real Apple Team ID is present, which
 * `readMobileConfig` already requires for release builds. A development build
 * without one simply omits the entitlement instead of shipping a placeholder.
 */
const associatedDomains = mobile.appleTeamId
  ? [`applinks:${mobile.webHost}`, `webcredentials:${mobile.webHost}`]
  : undefined;

const config: ExpoConfig = {
  name: mobile.appName,
  slug: "openmapx",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  scheme: mobile.scheme,
  userInterfaceStyle: "automatic",
  // Localized iOS `Info.plist` strings. English and German are the only mobile
  // locales this release supports.
  locales: {
    en: "./config/locales/en.json",
    de: "./config/locales/de.json",
  },
  assetBundlePatterns: ["assets/**"],
  ios: {
    bundleIdentifier: mobile.appId,
    // Phone is the supported first-release form factor; no tablet layout is
    // claimed anywhere in the store metadata.
    supportsTablet: false,
    ...(associatedDomains && { associatedDomains }),
    config: { usesNonExemptEncryption: false },
    infoPlist: {
      // Location only. The `audio` background mode stays undeclared unless
      // volunteer-beta evidence proves spoken guidance needs it.
      UIBackgroundModes: ["location"],
      ...IOS_USAGE_DESCRIPTIONS.en,
    },
  },
  android: {
    package: mobile.appId,
    // A map chooser uses an implicit VIEW intent, independently of App Links.
    intentFilters: [
      {
        action: "VIEW",
        category: ["DEFAULT", "BROWSABLE"],
        data: [{ scheme: "geo" }],
      },
    ],
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: BRAND_COLOR,
    },
    permissions: [
      "android.permission.INTERNET",
      "android.permission.ACCESS_COARSE_LOCATION",
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.ACCESS_BACKGROUND_LOCATION",
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_LOCATION",
      "android.permission.POST_NOTIFICATIONS",
      "android.permission.POST_PROMOTED_NOTIFICATIONS",
      // The get-off alert vibrates, which is the part a rider notices with the
      // phone in a pocket. Declared explicitly rather than arriving silently
      // through expo-notifications' own manifest.
      "android.permission.VIBRATE",
      // Every location update reaches the task through a JobScheduler job, and
      // expo-task-manager always marks those persisted, which Android refuses
      // without this permission. Declaring it registers no boot receiver.
      "android.permission.RECEIVE_BOOT_COMPLETED",
    ],
    // Permissions some bundled Expo modules declare by default but this app
    // must not ship: no remote push, no exact alarms, no media/microphone
    // capability.
    blockedPermissions: [
      "com.google.android.c2dm.permission.RECEIVE",
      "android.permission.SCHEDULE_EXACT_ALARM",
      "android.permission.USE_EXACT_ALARM",
      "android.permission.RECORD_AUDIO",
      "android.permission.CAMERA",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
      "android.permission.READ_MEDIA_IMAGES",
      "android.permission.READ_MEDIA_VIDEO",
      "android.permission.READ_MEDIA_AUDIO",
      "android.permission.SYSTEM_ALERT_WINDOW",
      "android.permission.QUERY_ALL_PACKAGES",
    ],
  },
  plugins: [
    // Deliberately first. Expo composes mods so that the *last* registered
    // plugin's action runs *first*; listing OpenMapX's plugin at the head makes
    // its mods run last, which is the only position from which it can remove a
    // declaration another plugin added (an unused usage description, a push
    // entitlement, the bundle-identifier URL scheme).
    "./plugins/withOpenMapXNativeConfig",
    "./plugins/withNavigationSurfaces",
    [
      "expo-build-properties",
      {
        // SDK 57 opt-in: Xcode/iOS 27 builds cannot launch the legacy lifecycle.
        ios: { deploymentTarget: "16.4", enableSceneSupport: true },
        android: {
          minSdkVersion: 24,
          compileSdkVersion: 36,
          targetSdkVersion: 36,
          buildToolsVersion: "36.0.0",
        },
      },
    ],
    [
      "expo-splash-screen",
      {
        image: "./assets/splash-icon.png",
        imageWidth: 180,
        resizeMode: "contain",
        backgroundColor: THEME_COLORS.light.surface,
        dark: { backgroundColor: THEME_COLORS.dark.background },
        // Android 12 and later draw the splash image on a 288 dp canvas and
        // crop it to a 192 dp circle, which cut the corners and edges off the
        // square logo. This image already holds the whole canvas, with the
        // logo small enough that its rounded corners stay inside the circle.
        android: {
          image: "./assets/splash-icon-android.png",
          imageWidth: 288,
        },
      },
    ],
    [
      "expo-location",
      {
        locationWhenInUsePermission: IOS_USAGE_DESCRIPTIONS.en.NSLocationWhenInUseUsageDescription,
        locationAlwaysAndWhenInUsePermission:
          IOS_USAGE_DESCRIPTIONS.en.NSLocationAlwaysAndWhenInUseUsageDescription,
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
      },
    ],
    [
      "expo-notifications",
      {
        icon: "./assets/notification-icon.png",
        color: BRAND_COLOR,
        enableBackgroundRemoteNotifications: false,
      },
    ],
    "expo-system-ui",
  ],
  // Non-secret build inputs the running app reads through `expo-constants`.
  // Signing material, credentials and Team IDs never appear here.
  extra: {
    mobile: {
      release: mobile.release,
      feasibilityMode: mobile.feasibilityMode,
      webOrigin: mobile.webOrigin,
      apiOrigin: mobile.apiOrigin,
      webHost: mobile.webHost,
      appId: mobile.appId,
      scheme: mobile.scheme,
    },
  },
};

export default config;
