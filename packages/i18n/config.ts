import de from "./locales/de.json";
import en from "./locales/en.json";

/** Register each supported catalogue here; headless consumers share this registry. */
export const messages = { en, de };
export type Locale = keyof typeof messages;
export const locales = Object.keys(messages) as [Locale, ...Locale[]];
export const defaultLocale: Locale = "en";
export const localeNames: Record<Locale, string> = { en: "English", de: "Deutsch" };

export function resolveLocale(value?: string | null): Locale {
  if (!value) return defaultLocale;
  let candidate: string;
  try {
    candidate = Intl.getCanonicalLocales(value)[0].toLowerCase();
  } catch {
    return defaultLocale;
  }
  // Prefer the exact locale, then progressively less specific language tags.
  while (candidate) {
    const supported = locales.find((locale) => locale.toLowerCase() === candidate);
    if (supported) return supported;
    candidate = candidate.slice(0, Math.max(0, candidate.lastIndexOf("-")));
  }
  return defaultLocale;
}
