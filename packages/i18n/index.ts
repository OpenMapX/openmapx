export { default as de } from "./locales/de.json";
export { default as en } from "./locales/en.json";

export const locales = ["en", "de"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

/** Native display name for each supported locale (e.g. "English", "Deutsch"). */
export const localeNames: Record<Locale, string> = {
  en: "English",
  de: "Deutsch",
};

export {
  type FormatCueOptions,
  formatCueDistance,
  formatNavigationCue,
  NavigationCueError,
  type NavigationCueIntent,
  resetNavigationCueCache,
} from "./navigationCues";
