import type { Locale } from "./locale";
import de from "./locales/de.json";
import en from "./locales/en.json";

export { defaultLocale, type Locale, localeNames, locales, resolveLocale } from "./locale";

/** Register each supported catalogue here and its tag in `locale.ts`; headless consumers share this registry. */
export const messages = { en, de } satisfies Record<Locale, unknown>;
