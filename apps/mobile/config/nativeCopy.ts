/**
 * Native bootstrap copy.
 *
 * These strings are needed before any application-level i18n runtime exists:
 * the iOS usage descriptions are compiled into `Info.plist` at generation time,
 * and the Android foreground-service notification is created by the location
 * driver inside a headless task that never mounts React. Product UI copy lives
 * in `@openmapx/i18n`; this catalog is deliberately limited to text the
 * operating system itself renders.
 *
 * Everything here is plain TypeScript with no imports so it can be loaded by
 * `app.config.ts` under Expo's config loader, by Metro inside the app bundle,
 * and by Vitest — three environments with three different module systems.
 * `config/locales/*.json` mirror the iOS entries for Expo's `locales` field and
 * are kept honest by `nativeCopy.test.ts`.
 */

export const MOBILE_LOCALES = ["en", "de"] as const;
export type MobileLocale = (typeof MOBILE_LOCALES)[number];

export interface IosUsageDescriptions {
  NSLocationWhenInUseUsageDescription: string;
  NSLocationAlwaysAndWhenInUseUsageDescription: string;
}

/**
 * The display name is deliberately absent: it comes from the config's `name`,
 * which already distinguishes the store build from a development build. Pinning
 * it here would force both to render as "OpenMapX" on the home screen.
 */
export const IOS_USAGE_DESCRIPTIONS: Record<MobileLocale, IosUsageDescriptions> = {
  en: {
    NSLocationWhenInUseUsageDescription:
      "OpenMapX uses your location to show where you are on the map and to guide you along a route you start.",
    NSLocationAlwaysAndWhenInUseUsageDescription:
      "OpenMapX uses your location in the background so navigation you have started keeps guiding you while the screen is locked or the app is not in use. Tracking stops when you end navigation.",
  },
  de: {
    NSLocationWhenInUseUsageDescription:
      "OpenMapX verwendet deinen Standort, um deine Position auf der Karte anzuzeigen und dich entlang einer von dir gestarteten Route zu führen.",
    NSLocationAlwaysAndWhenInUseUsageDescription:
      "OpenMapX verwendet deinen Standort im Hintergrund, damit eine von dir gestartete Navigation dich weiter führt, während der Bildschirm gesperrt ist oder die App nicht verwendet wird. Die Standorterfassung endet, sobald du die Navigation beendest.",
  },
};

export interface AndroidForegroundServiceCopy {
  notificationTitle: string;
  notificationBody: string;
}

export const ANDROID_FOREGROUND_SERVICE_COPY: Record<MobileLocale, AndroidForegroundServiceCopy> = {
  en: {
    notificationTitle: "OpenMapX navigation is running",
    notificationBody: "Using your location to guide you. Tap to open, or end navigation to stop.",
  },
  de: {
    notificationTitle: "OpenMapX-Navigation läuft",
    notificationBody:
      "Dein Standort wird zur Führung verwendet. Tippen zum Öffnen oder Navigation beenden.",
  },
};

/** Narrows an arbitrary locale tag to a supported mobile locale, defaulting to English. */
export function resolveMobileLocale(value: string | undefined | null): MobileLocale {
  const tag = value?.toLowerCase().split("-")[0];
  return (MOBILE_LOCALES as readonly string[]).includes(tag ?? "") ? (tag as MobileLocale) : "en";
}
