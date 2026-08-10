import IntlMessageFormat from "intl-messageformat";
import type { Locale } from "./index";
import de from "./locales/de.json";
import en from "./locales/en.json";

/**
 * Localised spoken and status text for navigation, usable from a headless
 * background task.
 *
 * The background bundle has no React and no `next-intl`, but it still must not
 * grow a second phrase catalogue: a German cue that only exists in Swift or in
 * a mobile-only JSON file is a cue that never gets reviewed by a translator.
 * So this formats the *canonical* `@openmapx/i18n` messages with ICU, and the
 * web app keeps using the same keys through next-intl.
 *
 * Callers pass a semantic intent, never a message key. That is deliberate: a
 * caller-supplied key would let a compromised page reach any string in the
 * catalogue and have it spoken aloud.
 */

/** The complete set of things navigation can say. */
export type NavigationCueIntent =
  | {
      kind: "ground-maneuver";
      tier: "far" | "near" | "now";
      instruction: string;
      distanceMeters?: number;
    }
  | { kind: "walk"; action: string; street?: string; level?: number }
  | { kind: "board"; line: string; destination: string; platform?: string }
  | { kind: "alight"; stop: string }
  | { kind: "transfer"; stop: string; line: string }
  | { kind: "platform-change"; platform: string }
  | { kind: "off-route" }
  | { kind: "weak-gps" }
  | { kind: "schedule-fallback" }
  | { kind: "permission-lost" }
  | { kind: "arrival" };

export interface FormatCueOptions {
  units?: "metric" | "imperial";
}

export class NavigationCueError extends Error {}

/** Free-text bounds. Long enough for any real street or line name. */
const MAX_FREE_TEXT = 120;
const MAX_INSTRUCTION = 240;

const CATALOGS: Record<Locale, Record<string, unknown>> = { en, de };

/**
 * Compiled message cache, keyed by `locale:key`.
 *
 * `IntlMessageFormat` compilation is the expensive part, and a navigation
 * session formats the same handful of messages hundreds of times.
 */
const formatterCache = new Map<string, IntlMessageFormat>();

function messageFor(locale: Locale, key: string): string {
  const navigation = CATALOGS[locale]?.navigation as unknown as Record<string, string> | undefined;
  // English is the fallback when a locale is missing a key, so a translation
  // gap degrades to a readable cue rather than silence.
  const fallback = (en.navigation as unknown as Record<string, string>)[key];
  const message = navigation?.[key] ?? fallback;
  if (typeof message !== "string") {
    throw new NavigationCueError(`missing navigation message: ${key}`);
  }
  return message;
}

function format(locale: Locale, key: string, values: Record<string, string | number> = {}): string {
  const cacheKey = `${locale}:${key}`;
  let formatter = formatterCache.get(cacheKey);
  if (!formatter) {
    formatter = new IntlMessageFormat(messageFor(locale, key), locale);
    formatterCache.set(cacheKey, formatter);
  }
  const result = formatter.format(values);
  // A rich-text catalogue entry would return parts rather than a string, and
  // speaking "[object Object]" is worse than failing loudly.
  if (typeof result !== "string") {
    throw new NavigationCueError(`navigation message ${key} did not format to a string`);
  }
  return result;
}

function assertLocale(locale: unknown): asserts locale is Locale {
  if (locale !== "en" && locale !== "de") {
    throw new NavigationCueError("locale must be en or de");
  }
}

function assertText(value: unknown, field: string, max = MAX_FREE_TEXT): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new NavigationCueError(`${field} must be a non-empty string`);
  }
  if (value.length > max) throw new NavigationCueError(`${field} exceeds ${max} characters`);
  return value;
}

/**
 * Spoken distance, rounded the way a person would say it: coarse when far away,
 * precise when close.
 */
export function formatCueDistance(
  meters: number,
  locale: Locale,
  units: "metric" | "imperial",
): string {
  if (!Number.isFinite(meters) || meters < 0) {
    throw new NavigationCueError("distanceMeters must be a finite, non-negative number");
  }
  if (units === "imperial") {
    const feet = meters * 3.280_84;
    if (feet < 1_000) {
      const rounded = feet < 100 ? Math.round(feet / 10) * 10 : Math.round(feet / 50) * 50;
      return format(locale, "voiceDistanceFeet", { feet: rounded });
    }
    const miles = meters / 1_609.344;
    return format(locale, "voiceDistanceMiles", {
      miles: miles < 10 ? Math.round(miles * 10) / 10 : Math.round(miles),
    });
  }
  if (meters < 1_000) {
    const rounded = meters < 100 ? Math.round(meters / 10) * 10 : Math.round(meters / 50) * 50;
    return format(locale, "voiceDistanceMeters", { meters: rounded });
  }
  const kilometers = meters / 1_000;
  return format(locale, "voiceDistanceKilometers", {
    kilometers: kilometers < 10 ? Math.round(kilometers * 10) / 10 : Math.round(kilometers),
  });
}

/**
 * Turns a semantic intent into speakable localised text.
 *
 * Values are interpolated as plain strings. ICU has no markup semantics unless a
 * message declares a tag, and none of these do, so a street called `<b>Main` is
 * spoken literally rather than interpreted.
 */
export function formatNavigationCue(
  intent: NavigationCueIntent,
  locale: Locale,
  options: FormatCueOptions = {},
): string {
  assertLocale(locale);
  const units = options.units ?? "metric";

  switch (intent.kind) {
    case "ground-maneuver": {
      const instruction = assertText(intent.instruction, "instruction", MAX_INSTRUCTION);
      // The imminent cue drops the distance: by then the turn is right there.
      if (intent.tier === "now" || intent.distanceMeters === undefined) return instruction;
      return format(locale, "voiceUpcoming", {
        distance: formatCueDistance(intent.distanceMeters, locale, units),
        instruction,
      });
    }
    case "walk": {
      const action = assertText(intent.action, "action");
      if (intent.level !== undefined) {
        if (!Number.isInteger(intent.level) || Math.abs(intent.level) > 200) {
          throw new NavigationCueError("level must be a plausible integer");
        }
        return format(locale, "walkToLevel", { action, level: intent.level });
      }
      if (intent.street !== undefined) {
        return format(locale, "walkOnStreet", {
          action,
          street: assertText(intent.street, "street"),
        });
      }
      return action;
    }
    case "board": {
      const line = assertText(intent.line, "line");
      const destination = assertText(intent.destination, "destination");
      if (intent.platform !== undefined) {
        return format(locale, "voiceBoardPlatform", {
          line,
          destination,
          platform: assertText(intent.platform, "platform"),
        });
      }
      return format(locale, "voiceBoard", { line, destination });
    }
    case "alight":
      return format(locale, "voiceAlight", { stop: assertText(intent.stop, "stop") });
    case "transfer":
      return format(locale, "voiceTransfer", {
        stop: assertText(intent.stop, "stop"),
        line: assertText(intent.line, "line"),
      });
    case "platform-change":
      return format(locale, "voicePlatformChange", {
        platform: assertText(intent.platform, "platform"),
      });
    case "off-route":
      return format(locale, "voiceOffRoute");
    case "weak-gps":
      return format(locale, "weakGps");
    case "schedule-fallback":
      return format(locale, "voiceScheduleFallback");
    case "permission-lost":
      return format(locale, "voicePermissionLost");
    case "arrival":
      return format(locale, "arrived");
    default: {
      // Exhaustiveness: a new intent must be handled, never silently spoken as
      // an empty string.
      const exhaustive: never = intent;
      throw new NavigationCueError(`unsupported cue intent: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Test seam: clears the compiled-message cache. */
export function resetNavigationCueCache(): void {
  formatterCache.clear();
}
