/**
 * Supported locales without the message catalogues, so browser bundles can
 * resolve and list locales without shipping every language's messages.
 * `config.ts` registers a catalogue for each entry; `locale.test.ts` and the
 * `satisfies` check there keep the two in step.
 */
export type Locale = "en" | "de";
/** Registration order: the language picker lists locales in this order. */
export const locales: [Locale, ...Locale[]] = ["en", "de"];
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
